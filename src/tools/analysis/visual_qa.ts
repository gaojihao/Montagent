/**
 * Visual QA tool for automated video quality checks.
 *
 * TypeScript port of tools/analysis/visual_qa.py. Extracts frames at specified
 * timestamps and runs basic quality checks (probe metadata + validation,
 * frame extraction for visual inspection, audio-level measurement via
 * volumedetect). Returns frame paths so the agent can visually inspect them.
 *
 * Parity notes vs. Python:
 *  - FFmpeg/ffprobe arg arrays translated verbatim, including the platform-
 *    specific null sink (NUL on win32, /dev/null elsewhere) used by the
 *    volumedetect audio_levels probe.
 *  - volumedetect writes mean_volume/max_volume to stderr; we read
 *    result.stderr (String()) and parse with the same string splits as Python.
 *  - The frame filename label `f"{ts:.1f}".replace(".", "_")`, the auto-
 *    generated timestamps, validation issue strings, and result data shapes all
 *    match the Python verbatim.
 */
import fs from "node:fs";
import path from "node:path";
import {
  BaseTool,
  Determinism,
  ExecutionMode,
  ResourceProfile,
  ToolResult,
  ToolStability,
  ToolTier,
  toolResult,
} from "../base_tool.js";

interface FrameEntry {
  timestamp: number;
  path: string | null;
  error?: string;
}

export class VisualQA extends BaseTool {
  override name = "visual_qa";
  override version = "0.1.0";
  override tier = ToolTier.CORE;
  override capability = "analysis";
  override provider = "ffmpeg";
  override stability = ToolStability.EXPERIMENTAL;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;

  override dependencies = ["cmd:ffmpeg", "cmd:ffprobe"];
  override install_instructions = "Install FFmpeg: https://ffmpeg.org/download.html";
  override agent_skills = ["ffmpeg"];

  override capabilities = [
    "extract_review_frames",
    "probe_video",
    "check_audio_levels",
  ];

  override input_schema = {
    type: "object",
    required: ["operation", "input_path"],
    properties: {
      operation: {
        type: "string",
        enum: ["review", "probe", "audio_levels"],
        description:
          "review: extract frames at timestamps for visual inspection. " +
          "probe: get video metadata (duration, resolution, codecs). " +
          "audio_levels: check audio volume at specified timestamps.",
      },
      input_path: {
        type: "string",
        description: "Path to the video file to inspect.",
      },
      timestamps: {
        type: "array",
        items: { type: "number" },
        description:
          "Timestamps (in seconds) at which to extract frames or " +
          "check audio levels.",
      },
      output_dir: {
        type: "string",
        description:
          "Directory to save extracted frames. Defaults to a " +
          "'review_frames' subdirectory next to the input file.",
      },
      checks: {
        type: "array",
        items: {
          type: "string",
          enum: [
            "resolution",
            "duration",
            "audio_present",
            "pixel_format",
            "file_size",
          ],
        },
        description: "Specific checks to run (probe operation).",
      },
      expected: {
        type: "object",
        description:
          "Expected values for validation. " +
          "Keys: width, height, min_duration, max_duration, " +
          "pixel_format, has_audio.",
        properties: {
          width: { type: "integer" },
          height: { type: "integer" },
          min_duration: { type: "number" },
          max_duration: { type: "number" },
          pixel_format: { type: "string" },
          has_audio: { type: "boolean" },
        },
      },
    },
  };

  override resource_profile: ResourceProfile = {
    cpu_cores: 1,
    ram_mb: 512,
    vram_mb: 0,
    disk_mb: 200,
    network_required: false,
  };
  override idempotency_key_fields = ["operation", "input_path", "timestamps"];
  override side_effects = ["writes frame images to output_dir"];
  override user_visible_verification = [
    "Visually inspect extracted frames for quality issues",
  ];

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const operation = inputs.operation as string;
    const inputPath = inputs.input_path as string;

    if (!fs.existsSync(inputPath)) {
      return toolResult({ success: false, error: `Input not found: ${inputPath}` });
    }

    const start = Date.now();

    let result: ToolResult;
    try {
      if (operation === "review") {
        result = await this._review(inputs);
      } else if (operation === "probe") {
        result = await this._probe(inputs);
      } else if (operation === "audio_levels") {
        result = await this._audioLevels(inputs);
      } else {
        return toolResult({ success: false, error: `Unknown operation: ${operation}` });
      }
    } catch (e) {
      return toolResult({ success: false, error: String((e as Error).message ?? e) });
    }

    result.duration_seconds = round((Date.now() - start) / 1000, 2);
    return result;
  }

  /** Extract frames at specified timestamps for visual review. */
  private async _review(inputs: Record<string, unknown>): Promise<ToolResult> {
    const inputPath = inputs.input_path as string;
    let timestamps = (inputs.timestamps as number[]) ?? [];

    if (timestamps.length === 0) {
      // Auto-generate timestamps: start, 25%, 50%, 75%, end-1s
      const dur = await this._getDuration(inputPath);
      timestamps = [1.0, dur * 0.25, dur * 0.5, dur * 0.75, Math.max(dur - 1.0, 0)];
    }

    let outputDir = inputs.output_dir as string | undefined;
    if (!outputDir) {
      outputDir = path.join(path.dirname(inputPath), "review_frames");
    }
    fs.mkdirSync(outputDir, { recursive: true });

    const frames: FrameEntry[] = [];
    for (const ts of timestamps) {
      const tsLabel = ts.toFixed(1).replace(".", "_");
      const framePath = path.join(outputDir, `frame_${tsLabel}s.jpg`);
      const cmd = [
        "ffmpeg",
        "-y",
        "-ss",
        String(ts),
        "-i",
        inputPath,
        "-frames:v",
        "1",
        "-q:v",
        "2",
        framePath,
      ];
      try {
        await this.runCommand(cmd);
        if (fs.existsSync(framePath)) {
          frames.push({ timestamp: ts, path: framePath });
        }
      } catch {
        frames.push({
          timestamp: ts,
          path: null,
          error: `Failed to extract frame at ${ts}s`,
        });
      }
    }

    return toolResult({
      success: true,
      data: {
        operation: "review",
        input: inputPath,
        frame_count: frames.filter((f) => f.path).length,
        frames,
      },
      artifacts: frames.filter((f) => f.path).map((f) => f.path as string),
    });
  }

  /** Probe video metadata and optionally validate against expectations. */
  private async _probe(inputs: Record<string, unknown>): Promise<ToolResult> {
    const inputPath = inputs.input_path as string;
    const expected = (inputs.expected as Record<string, unknown>) ?? {};

    // Get comprehensive probe data
    const cmd = [
      "ffprobe",
      "-v",
      "error",
      "-show_entries",
      "format=duration,size:stream=width,height,codec_name,pix_fmt," +
        "r_frame_rate,sample_rate,channels,codec_type",
      "-of",
      "json",
      inputPath,
    ];
    const probeResult = await this.runCommand(cmd);
    const probeData = JSON.parse(String(probeResult.stdout ?? "")) as {
      format?: Record<string, unknown>;
      streams?: Array<Record<string, unknown>>;
    };

    // Extract key info
    let videoStream: Record<string, unknown> | null = null;
    let audioStream: Record<string, unknown> | null = null;
    for (const s of probeData.streams ?? []) {
      if (s.codec_type === "video" && !videoStream) {
        videoStream = s;
      } else if (s.codec_type === "audio" && !audioStream) {
        audioStream = s;
      }
    }

    const info: Record<string, unknown> = {
      duration: parseFloat(String(probeData.format?.duration ?? 0)),
      file_size_mb: round(
        Math.trunc(Number(probeData.format?.size ?? 0)) / 1048576,
        1
      ),
      has_audio: audioStream !== null,
    };
    if (videoStream) {
      info.width = videoStream.width ?? null;
      info.height = videoStream.height ?? null;
      info.pixel_format = videoStream.pix_fmt ?? null;
      info.video_codec = videoStream.codec_name ?? null;
      info.frame_rate = videoStream.r_frame_rate ?? null;
    }
    if (audioStream) {
      info.audio_codec = audioStream.codec_name ?? null;
      info.sample_rate = audioStream.sample_rate ?? null;
      info.channels = audioStream.channels ?? null;
    }

    // Validate against expectations
    const issues: string[] = [];
    if ("width" in expected && info.width !== expected.width) {
      issues.push(`Width: expected ${expected.width}, got ${info.width}`);
    }
    if ("height" in expected && info.height !== expected.height) {
      issues.push(`Height: expected ${expected.height}, got ${info.height}`);
    }
    if (
      "min_duration" in expected &&
      (info.duration as number) < (expected.min_duration as number)
    ) {
      issues.push(
        `Duration too short: ${(info.duration as number).toFixed(1)}s < ${expected.min_duration}s`
      );
    }
    if (
      "max_duration" in expected &&
      (info.duration as number) > (expected.max_duration as number)
    ) {
      issues.push(
        `Duration too long: ${(info.duration as number).toFixed(1)}s > ${expected.max_duration}s`
      );
    }
    if ("pixel_format" in expected && info.pixel_format !== expected.pixel_format) {
      issues.push(
        `Pixel format: expected ${expected.pixel_format}, got ${info.pixel_format}`
      );
    }
    if ("has_audio" in expected && info.has_audio !== expected.has_audio) {
      issues.push(
        `Audio: expected ${expected.has_audio ? "present" : "absent"}, ` +
          `got ${info.has_audio ? "present" : "absent"}`
      );
    }

    info.validation_issues = issues;
    info.validation_passed = issues.length === 0;

    return toolResult({
      success: true,
      data: {
        operation: "probe",
        input: inputPath,
        ...info,
      },
    });
  }

  /** Check audio levels at specified timestamps. */
  private async _audioLevels(inputs: Record<string, unknown>): Promise<ToolResult> {
    const inputPath = inputs.input_path as string;
    let timestamps = (inputs.timestamps as number[]) ?? [];

    if (timestamps.length === 0) {
      const dur = await this._getDuration(inputPath);
      timestamps = [1.0, dur * 0.5, Math.max(dur - 2.0, 0)];
    }

    const nullSink = process.platform === "win32" ? "NUL" : "/dev/null";

    const levels: Array<Record<string, unknown>> = [];
    for (const ts of timestamps) {
      const cmd = [
        "ffmpeg",
        "-y",
        "-ss",
        String(ts),
        "-t",
        "3",
        "-i",
        inputPath,
        "-vn",
        "-af",
        "volumedetect",
        "-f",
        "null",
        nullSink,
      ];
      try {
        let output: string;
        try {
          const cmdResult = await this.runCommand(cmd);
          output = String(cmdResult.stderr ?? ""); // volumedetect outputs to stderr
        } catch (e) {
          // ffmpeg may exit non-zero yet still write the detect log to stderr.
          const err = e as { stderr?: string; message?: string };
          if (err.stderr === undefined) throw e;
          output = err.stderr;
        }
        let meanVol: number | null = null;
        let maxVol: number | null = null;
        for (const line of output.split("\n")) {
          if (line.includes("mean_volume")) {
            meanVol = parseFloat(
              line.split("mean_volume:")[1]!.trim().split(/\s+/)[0]!
            );
          } else if (line.includes("max_volume")) {
            maxVol = parseFloat(
              line.split("max_volume:")[1]!.trim().split(/\s+/)[0]!
            );
          }
        }
        levels.push({
          timestamp: ts,
          mean_volume_db: meanVol,
          max_volume_db: maxVol,
        });
      } catch (e) {
        levels.push({
          timestamp: ts,
          error: String((e as Error).message ?? e),
        });
      }
    }

    return toolResult({
      success: true,
      data: {
        operation: "audio_levels",
        input: inputPath,
        levels,
      },
    });
  }

  private async _getDuration(filePath: string): Promise<number> {
    const cmd = [
      "ffprobe",
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      filePath,
    ];
    const durResult = await this.runCommand(cmd);
    return parseFloat(String(durResult.stdout ?? "").trim().split("\n")[0]!);
  }
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
