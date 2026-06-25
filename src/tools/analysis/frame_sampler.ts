/**
 * Frame sampler tool wrapping FFmpeg.
 *
 * TypeScript port of tools/analysis/frame_sampler.py. Extracts representative
 * frames from video for AI analysis, thumbnails, or quality inspection.
 * Supports interval-based, count-based, timestamp-based, and scene-guided
 * extraction strategies.
 *
 * Parity notes vs. Python:
 *  - FFmpeg/ffprobe arg arrays translated verbatim to this.runCommand([...]).
 *  - Frame filename zero-padding (frame_%04d / frame_{i:04d}) and timestamp
 *    rounding (round(t, 3)) match Python exactly.
 *  - _collect_frames replicates Python's `sorted(output_dir.glob("frame_*.ext"))`
 *    using fs.readdirSync + lexical sort (matches CPython glob sort order for
 *    these zero-padded names).
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

interface FrameRecord {
  path: string;
  timestamp_seconds: number;
  index: number;
  error?: string;
}

export class FrameSampler extends BaseTool {
  override name = "frame_sampler";
  override version = "0.1.0";
  override tier = ToolTier.CORE;
  override capability = "analysis";
  override provider = "ffmpeg";
  override stability = ToolStability.EXPERIMENTAL;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;

  override dependencies = ["cmd:ffmpeg"];
  override install_instructions = "Install FFmpeg: https://ffmpeg.org/download.html";
  override agent_skills = ["ffmpeg"];

  override capabilities = [
    "extract_frames_interval",
    "extract_frames_count",
    "extract_frames_timestamps",
    "extract_frames_scene_guided",
  ];

  override input_schema = {
    type: "object",
    required: ["input_path", "strategy"],
    properties: {
      input_path: { type: "string" },
      strategy: {
        type: "string",
        enum: ["interval", "count", "timestamps", "scene_guided"],
      },
      interval_seconds: {
        type: "number",
        minimum: 0.1,
        description: "Seconds between frames (for interval strategy)",
      },
      count: {
        type: "integer",
        minimum: 1,
        description: "Total frames to extract (for count strategy)",
      },
      timestamps: {
        type: "array",
        items: { type: "number" },
        description: "Specific timestamps in seconds (for timestamps strategy)",
      },
      scene_boundaries: {
        type: "array",
        items: {
          type: "object",
          properties: {
            start_seconds: { type: "number" },
            end_seconds: { type: "number" },
          },
        },
        description: "Scene boundary list (for scene_guided strategy)",
      },
      max_frames: {
        type: "integer",
        minimum: 1,
        default: 20,
        description: "Max frames to extract (for scene_guided strategy)",
      },
      output_dir: { type: "string" },
      format: { type: "string", enum: ["png", "jpg"], default: "jpg" },
      quality: { type: "integer", minimum: 1, maximum: 31, default: 2 },
    },
  };

  override resource_profile: ResourceProfile = {
    cpu_cores: 1,
    ram_mb: 512,
    vram_mb: 0,
    disk_mb: 500,
    network_required: false,
  };
  override idempotency_key_fields = [
    "input_path",
    "strategy",
    "interval_seconds",
    "count",
  ];
  override side_effects = ["writes frame images to output_dir"];
  override user_visible_verification = [
    "Inspect extracted frames for representative coverage",
  ];

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const inputPath = inputs.input_path as string;
    if (!fs.existsSync(inputPath)) {
      return toolResult({ success: false, error: `Input not found: ${inputPath}` });
    }

    const strategy = inputs.strategy as string;
    const fmt = (inputs.format as string) ?? "jpg";
    const quality = (inputs.quality as number) ?? 2;
    const outputDir =
      (inputs.output_dir as string) ??
      path.join(path.dirname(inputPath), "frames");
    fs.mkdirSync(outputDir, { recursive: true });

    const start = Date.now();

    let frames: FrameRecord[];
    try {
      if (strategy === "interval") {
        frames = await this._extractInterval(inputPath, outputDir, fmt, quality, inputs);
      } else if (strategy === "count") {
        frames = await this._extractCount(inputPath, outputDir, fmt, quality, inputs);
      } else if (strategy === "timestamps") {
        frames = await this._extractTimestamps(inputPath, outputDir, fmt, quality, inputs);
      } else if (strategy === "scene_guided") {
        frames = await this._extractSceneGuided(inputPath, outputDir, fmt, quality, inputs);
      } else {
        return toolResult({ success: false, error: `Unknown strategy: ${strategy}` });
      }
    } catch (e) {
      return toolResult({ success: false, error: String((e as Error).message ?? e) });
    }

    const elapsed = (Date.now() - start) / 1000;

    return toolResult({
      success: true,
      data: {
        strategy,
        frame_count: frames.length,
        frames,
        output_dir: outputDir,
      },
      artifacts: [outputDir],
      duration_seconds: round(elapsed, 2),
    });
  }

  private async _extractInterval(
    inputPath: string,
    outputDir: string,
    fmt: string,
    quality: number,
    inputs: Record<string, unknown>
  ): Promise<FrameRecord[]> {
    const interval = (inputs.interval_seconds as number) ?? 5.0;
    const outputPattern = path.join(outputDir, `frame_%04d.${fmt}`);

    const cmd = ["ffmpeg", "-y", "-i", inputPath, "-vf", `fps=1/${interval}`];
    if (fmt === "jpg") {
      cmd.push("-qscale:v", String(quality));
    }
    cmd.push(outputPattern);

    await this.runCommand(cmd);

    return this._collectFrames(outputDir, fmt, interval);
  }

  private async _extractCount(
    inputPath: string,
    outputDir: string,
    fmt: string,
    quality: number,
    inputs: Record<string, unknown>
  ): Promise<FrameRecord[]> {
    const count = (inputs.count as number) ?? 10;
    const duration = await this._getDuration(inputPath);
    if (duration <= 0) {
      return [];
    }

    const interval = duration / count;
    const outputPattern = path.join(outputDir, `frame_%04d.${fmt}`);

    const cmd = [
      "ffmpeg",
      "-y",
      "-i",
      inputPath,
      "-vf",
      `fps=1/${interval}`,
      "-frames:v",
      String(count),
    ];
    if (fmt === "jpg") {
      cmd.push("-qscale:v", String(quality));
    }
    cmd.push(outputPattern);

    await this.runCommand(cmd);

    return this._collectFrames(outputDir, fmt, interval);
  }

  private async _extractTimestamps(
    inputPath: string,
    outputDir: string,
    fmt: string,
    quality: number,
    inputs: Record<string, unknown>
  ): Promise<FrameRecord[]> {
    const timestamps = (inputs.timestamps as number[]) ?? [];
    const frames: FrameRecord[] = [];

    for (let i = 0; i < timestamps.length; i++) {
      const ts = timestamps[i]!;
      const outputFile = path.join(outputDir, `frame_${pad4(i)}.${fmt}`);
      const cmd = [
        "ffmpeg",
        "-y",
        "-ss",
        String(ts),
        "-i",
        inputPath,
        "-frames:v",
        "1",
      ];
      if (fmt === "jpg") {
        cmd.push("-qscale:v", String(quality));
      }
      cmd.push(outputFile);

      await this.runCommand(cmd);

      if (fs.existsSync(outputFile)) {
        frames.push({
          path: outputFile,
          timestamp_seconds: ts,
          index: i,
        });
      }
    }

    return frames;
  }

  /**
   * Extract keyframes guided by scene boundaries.
   *
   * Extracts the first frame of each scene plus a midpoint frame for scenes
   * longer than 3 seconds. This captures all visual transitions with a bounded,
   * predictable number of frames — much better than uniform FPS.
   */
  private async _extractSceneGuided(
    inputPath: string,
    outputDir: string,
    fmt: string,
    quality: number,
    inputs: Record<string, unknown>
  ): Promise<FrameRecord[]> {
    const sceneBoundaries =
      (inputs.scene_boundaries as Array<Record<string, unknown>>) ?? [];
    const maxFrames = (inputs.max_frames as number) ?? 20;

    if (sceneBoundaries.length === 0) {
      // No scene data — fall back to count-based
      return this._extractCount(inputPath, outputDir, fmt, quality, {
        count: Math.min(maxFrames, 15),
      });
    }

    // Compute timestamps: first frame + midpoint for long scenes
    let timestamps: number[] = [];
    for (const scene of sceneBoundaries) {
      const sceneStart = (scene.start_seconds as number) ?? 0;
      const end = (scene.end_seconds as number) ?? 0;
      const duration = end - sceneStart;

      // First frame of scene (offset slightly to avoid black frames)
      timestamps.push(sceneStart + 0.1);

      // Midpoint for scenes > 3 seconds
      if (duration > 3.0) {
        timestamps.push(sceneStart + duration / 2);
      }
    }

    // Deduplicate, sort, limit
    timestamps = uniqueSortedRounded(timestamps, 3);
    if (timestamps.length > maxFrames) {
      const step = timestamps.length / maxFrames;
      const limited: number[] = [];
      for (let i = 0; i < maxFrames; i++) {
        limited.push(timestamps[Math.trunc(i * step)]!);
      }
      timestamps = limited;
    }

    // Extract via timestamps strategy
    return this._extractTimestamps(inputPath, outputDir, fmt, quality, {
      timestamps,
    });
  }

  /** Get video duration in seconds via ffprobe. */
  private async _getDuration(inputPath: string): Promise<number> {
    const cmd = [
      "ffprobe",
      "-v",
      "quiet",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
      inputPath,
    ];
    const result = await this.runCommand(cmd);
    const data = JSON.parse(String(result.stdout ?? "")) as {
      format?: { duration?: string };
    };
    return parseFloat(String(data.format?.duration ?? 0));
  }

  /** Collect extracted frame files and build metadata. */
  private _collectFrames(
    outputDir: string,
    fmt: string,
    interval: number
  ): FrameRecord[] {
    const frames: FrameRecord[] = [];
    // Mirror Python's sorted(output_dir.glob(f"frame_*.{fmt}")).
    let files: string[];
    try {
      files = fs.readdirSync(outputDir);
    } catch {
      files = [];
    }
    const suffix = `.${fmt}`;
    const matched = files
      .filter((f) => f.startsWith("frame_") && f.endsWith(suffix))
      .sort();
    for (let i = 0; i < matched.length; i++) {
      frames.push({
        path: path.join(outputDir, matched[i]!),
        timestamp_seconds: round(i * interval, 3),
        index: i,
      });
    }
    return frames;
  }
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function pad4(n: number): string {
  return String(n).padStart(4, "0");
}

/** Python: sorted(set(round(t, 3) for t in timestamps)). */
function uniqueSortedRounded(values: number[], digits: number): number[] {
  const seen = new Set<number>();
  for (const v of values) {
    seen.add(round(v, digits));
  }
  return [...seen].sort((a, b) => a - b);
}
