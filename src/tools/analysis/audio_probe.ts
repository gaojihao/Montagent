/**
 * Lightweight audio/video file probe using ffprobe.
 *
 * TypeScript port of tools/analysis/audio_probe.py. Returns duration, format,
 * sample rate, channels, and codec info for any media file ffprobe can read.
 * No heavy dependencies — just requires ffmpeg/ffprobe on PATH.
 *
 * Parity notes vs. Python:
 *  - The Python module exposed a free `probe_duration(file_path)` helper used by
 *    other tools (e.g. composition_validator) to grab duration without going
 *    through execute(). It is ported here as the exported async `probeDuration`.
 *    Python's helper was synchronous (subprocess.run); the TS port is async
 *    because execa is async — composition_validator awaits it.
 *  - Python declared dependencies=["binary:ffprobe"] and overrode get_status()
 *    to check shutil.which("ffprobe"). The TS port uses dependencies=
 *    ["cmd:ffprobe"] so the base getStatus() drives availability identically.
 *  - ffprobe arg arrays, JSON parsing, rounding, and the probe_data shape match
 *    the Python verbatim (duration rounded to 3, int() coercions, audio block).
 */
import fs from "node:fs";
import { execa } from "execa";
import {
  BaseTool,
  Determinism,
  ExecutionMode,
  ResourceProfile,
  RetryPolicy,
  ToolResult,
  ToolRuntime,
  ToolStability,
  ToolTier,
  toolResult,
} from "../base_tool.js";

/**
 * Quick helper: return duration in seconds, or null on failure.
 *
 * Use this from other tools that just need the duration without going through
 * the full tool execute() flow. Async port of the Python `probe_duration`.
 */
export async function probeDuration(filePath: string): Promise<number | null> {
  try {
    const result = await execa(
      "ffprobe",
      [
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        filePath,
      ],
      { timeout: 10000 }
    );
    const data = JSON.parse(String(result.stdout ?? "")) as {
      format: { duration: string };
    };
    return parseFloat(data.format.duration);
  } catch {
    return null;
  }
}

export class AudioProbe extends BaseTool {
  override name = "audio_probe";
  override version = "0.1.0";
  override tier = ToolTier.CORE;
  override capability = "analysis";
  override provider = "ffprobe";
  override stability = ToolStability.PRODUCTION;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;
  override runtime = ToolRuntime.LOCAL;

  override dependencies = ["cmd:ffprobe"];
  override install_instructions =
    "Install ffmpeg (includes ffprobe):\n" +
    "  Windows: winget install ffmpeg\n" +
    "  macOS: brew install ffmpeg\n" +
    "  Linux: sudo apt install ffmpeg";

  override capabilities = ["probe_duration", "probe_format", "probe_streams"];
  override best_for = [
    "getting audio/video duration before composition",
    "validating media file format and codec",
    "pre-render checks on asset files",
  ];

  override input_schema = {
    type: "object",
    required: ["input_path"],
    properties: {
      input_path: {
        type: "string",
        description: "Path to audio or video file",
      },
    },
  };

  override resource_profile: ResourceProfile = {
    cpu_cores: 1,
    ram_mb: 64,
    vram_mb: 0,
    disk_mb: 0,
    network_required: false,
  };
  override retry_policy: RetryPolicy = {
    max_retries: 0,
    backoff_seconds: 1.0,
    retryable_errors: [],
  };
  override idempotency_key_fields = ["input_path"];
  override side_effects = [];

  override estimateCost(_inputs: Record<string, unknown>): number {
    return 0.0;
  }

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const inputPath = inputs.input_path as string;
    if (!fs.existsSync(inputPath)) {
      return toolResult({ success: false, error: `File not found: ${inputPath}` });
    }

    const start = Date.now();

    let data: {
      format?: Record<string, unknown>;
      streams?: Array<Record<string, unknown>>;
    };
    try {
      const result = await this.runCommand(
        [
          "ffprobe",
          "-v",
          "quiet",
          "-print_format",
          "json",
          "-show_format",
          "-show_streams",
          inputPath,
        ],
        { timeout: 15000 }
      );

      if (result.exitCode !== 0) {
        return toolResult({
          success: false,
          error: `ffprobe failed: ${String(result.stderr ?? "").trim()}`,
        });
      }

      data = JSON.parse(String(result.stdout ?? ""));
    } catch (e) {
      const err = e as { timedOut?: boolean; stderr?: string };
      if (err.timedOut) {
        return toolResult({ success: false, error: "ffprobe timed out (15s)" });
      }
      // Non-zero exit (execa rejected) or invalid JSON.
      if (e instanceof SyntaxError) {
        return toolResult({ success: false, error: "ffprobe returned invalid JSON" });
      }
      return toolResult({
        success: false,
        error: `ffprobe failed: ${(err.stderr ?? "").trim() || (e as Error).message}`,
      });
    }

    const fmt = data.format ?? {};
    const streams = data.streams ?? [];

    // Find audio stream
    const audioStream =
      streams.find((s) => s.codec_type === "audio") ?? null;

    const probeData: Record<string, unknown> = {
      file: inputPath,
      duration_seconds: round(parseFloat(String(fmt.duration ?? 0)), 3),
      format_name: fmt.format_name ?? null,
      format_long_name: fmt.format_long_name ?? null,
      size_bytes: parseIntPy(fmt.size),
      bit_rate: parseIntPy(fmt.bit_rate),
      stream_count: streams.length,
    };

    if (audioStream) {
      probeData.audio = {
        codec: audioStream.codec_name ?? null,
        sample_rate: parseIntPy(audioStream.sample_rate),
        channels: audioStream.channels ?? null,
        channel_layout: audioStream.channel_layout ?? null,
        bit_rate: audioStream.bit_rate
          ? parseIntPy(audioStream.bit_rate)
          : null,
      };
    }

    return toolResult({
      success: true,
      data: probeData,
      duration_seconds: round((Date.now() - start) / 1000, 2),
    });
  }
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Mirror Python int(value or 0): treat missing/None as 0, truncate toward zero. */
function parseIntPy(value: unknown): number {
  if (value === undefined || value === null || value === "") return 0;
  return Math.trunc(Number(value));
}
