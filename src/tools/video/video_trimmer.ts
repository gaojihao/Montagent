/**
 * Video trimmer tool wrapping FFmpeg.
 *
 * TypeScript port of tools/video/video_trimmer.py. Provides cut, trim, speed
 * adjustment, and concatenation of video segments. All operations are
 * deterministic and produce lossless or near-lossless output by default.
 *
 * Parity notes vs. Python:
 *  - FFmpeg argument arrays, the setpts/atempo filter strings, and the concat
 *    demuxer list file format are copied verbatim.
 *  - Path.with_stem(f"{stem}_cut") is reproduced with node:path helpers.
 *  - subprocess.run -> this.runCommand (execa); on failure execa rejects, which
 *    propagates exactly like the Python CalledProcessError bubbling to execute().
 */
import fs from "node:fs";
import path from "node:path";
import {
  BaseTool,
  Determinism,
  ExecutionMode,
  ResourceProfile,
  ResumeSupport,
  RetryPolicy,
  ToolResult,
  ToolStability,
  ToolTier,
  toolResult,
} from "../base_tool.js";

/** Reproduce Python's Path.with_stem: replace the filename stem, keep dir + suffix. */
function withStem(p: string, newStem: string): string {
  const dir = path.dirname(p);
  const ext = path.extname(p);
  return path.join(dir, `${newStem}${ext}`);
}

export class VideoTrimmer extends BaseTool {
  override name = "video_trimmer";
  override version = "0.1.0";
  override tier = ToolTier.CORE;
  override capability = "video_post";
  override provider = "ffmpeg";
  override stability = ToolStability.EXPERIMENTAL;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;

  override dependencies = ["cmd:ffmpeg"];
  override install_instructions =
    "Install FFmpeg: https://ffmpeg.org/download.html\n" +
    "Windows: winget install FFmpeg\n" +
    "macOS: brew install ffmpeg\n" +
    "Linux: sudo apt install ffmpeg";
  override agent_skills = ["ffmpeg", "video_toolkit"];

  override capabilities = ["cut", "trim", "speed_adjust", "concat"];

  override input_schema = {
    type: "object",
    required: ["operation"],
    properties: {
      operation: {
        type: "string",
        enum: ["cut", "speed", "concat"],
      },
      input_path: { type: "string" },
      output_path: { type: "string" },
      start_seconds: { type: "number", minimum: 0 },
      end_seconds: { type: "number", minimum: 0 },
      speed_factor: { type: "number", minimum: 0.1, maximum: 100.0 },
      segments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            input_path: { type: "string" },
            start_seconds: { type: "number" },
            end_seconds: { type: "number" },
          },
        },
      },
      codec: { type: "string", default: "copy" },
    },
  };

  override resource_profile: ResourceProfile = {
    cpu_cores: 2,
    ram_mb: 1024,
    vram_mb: 0,
    disk_mb: 2000,
    network_required: false,
  };
  override retry_policy: RetryPolicy = {
    max_retries: 1,
    backoff_seconds: 1.0,
    retryable_errors: ["FFmpeg error"],
  };
  override resume_support = ResumeSupport.FROM_START;
  override idempotency_key_fields = [
    "operation",
    "input_path",
    "start_seconds",
    "end_seconds",
    "speed_factor",
  ];
  override side_effects = ["writes video file to output_path"];
  override user_visible_verification = ["Play trimmed output and verify cut points"];

  override async execute(inputs: Record<string, any>): Promise<ToolResult> {
    const operation = inputs.operation as string;
    const start = Date.now();

    let result: ToolResult;
    try {
      if (operation === "cut") {
        result = await this._cut(inputs);
      } else if (operation === "speed") {
        result = await this._speed(inputs);
      } else if (operation === "concat") {
        result = await this._concat(inputs);
      } else {
        return toolResult({ success: false, error: `Unknown operation: ${operation}` });
      }
    } catch (e) {
      return toolResult({ success: false, error: `${(e as Error).message ?? e}` });
    }

    result.duration_seconds = Math.round((Date.now() - start) / 10) / 100;
    return result;
  }

  private async _cut(inputs: Record<string, any>): Promise<ToolResult> {
    const inputPath = inputs.input_path as string;
    if (!fs.existsSync(inputPath)) {
      return toolResult({ success: false, error: `Input not found: ${inputPath}` });
    }

    const startS = inputs.start_seconds ?? 0;
    const endS = inputs.end_seconds;
    const codec = inputs.codec ?? "copy";
    const outputPath =
      (inputs.output_path as string) ??
      withStem(inputPath, `${path.basename(inputPath, path.extname(inputPath))}_cut`);

    const cmd = ["ffmpeg", "-y", "-i", inputPath, "-ss", String(startS)];
    if (endS !== undefined && endS !== null) {
      cmd.push("-to", String(endS));
    }
    if (codec === "copy") {
      cmd.push("-c", "copy");
    } else {
      cmd.push("-c:v", codec, "-c:a", "aac");
    }
    cmd.push(outputPath);

    await this.runCommand(cmd);

    return toolResult({
      success: true,
      data: {
        operation: "cut",
        input: inputPath,
        output: outputPath,
        start_seconds: startS,
        end_seconds: endS ?? null,
      },
      artifacts: [outputPath],
    });
  }

  private async _speed(inputs: Record<string, any>): Promise<ToolResult> {
    const inputPath = inputs.input_path as string;
    if (!fs.existsSync(inputPath)) {
      return toolResult({ success: false, error: `Input not found: ${inputPath}` });
    }

    const factor = (inputs.speed_factor as number) ?? 1.0;
    const outputPath =
      (inputs.output_path as string) ??
      withStem(inputPath, `${path.basename(inputPath, path.extname(inputPath))}_speed`);

    // Video: setpts adjusts presentation timestamps (inverse of speed)
    // Audio: atempo adjusts audio speed (must chain for >2x)
    const videoFilter = `setpts=${1.0 / factor}*PTS`;
    const audioFilters = VideoTrimmer._buildAtempoChain(factor);

    const cmd = [
      "ffmpeg",
      "-y",
      "-i",
      inputPath,
      "-filter:v",
      videoFilter,
      "-filter:a",
      audioFilters,
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-c:a",
      "aac",
      outputPath,
    ];

    await this.runCommand(cmd);

    return toolResult({
      success: true,
      data: {
        operation: "speed",
        input: inputPath,
        output: outputPath,
        speed_factor: factor,
      },
      artifacts: [outputPath],
    });
  }

  private async _concat(inputs: Record<string, any>): Promise<ToolResult> {
    const segments = (inputs.segments as Array<Record<string, any>>) ?? [];
    if (segments.length === 0) {
      return toolResult({ success: false, error: "No segments provided for concat" });
    }

    const outputPath = (inputs.output_path as string) ?? "concat_output.mp4";

    // First, cut each segment to a temp file if start/end are specified
    const tempFiles: string[] = [];
    const tempDir = path.join(path.dirname(outputPath), ".concat_tmp");
    fs.mkdirSync(tempDir, { recursive: true });

    const listPath = path.join(tempDir, "concat_list.txt");
    try {
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i]!;
        const segInput = seg.input_path as string;
        if (!fs.existsSync(segInput)) {
          return toolResult({ success: false, error: `Segment input not found: ${segInput}` });
        }

        const segStart = seg.start_seconds;
        const segEnd = seg.end_seconds;

        if (
          (segStart !== undefined && segStart !== null) ||
          (segEnd !== undefined && segEnd !== null)
        ) {
          const tempPath = path.join(
            tempDir,
            `seg_${String(i).padStart(4, "0")}${path.extname(segInput)}`
          );
          const cmd = ["ffmpeg", "-y", "-i", segInput];
          if (segStart !== undefined && segStart !== null) {
            cmd.push("-ss", String(segStart));
          }
          if (segEnd !== undefined && segEnd !== null) {
            cmd.push("-to", String(segEnd));
          }
          cmd.push("-c", "copy", tempPath);
          await this.runCommand(cmd);
          tempFiles.push(tempPath);
        } else {
          tempFiles.push(segInput);
        }
      }

      // Write concat file list
      const lines = tempFiles
        .map((tf) => {
          // FFmpeg concat demuxer needs forward slashes and escaped quotes
          const safePath = path.resolve(tf).replace(/\\/g, "/");
          return `file '${safePath}'\n`;
        })
        .join("");
      fs.writeFileSync(listPath, lines, { encoding: "utf-8" });

      const cmd = [
        "ffmpeg",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listPath,
        "-c",
        "copy",
        outputPath,
      ];
      await this.runCommand(cmd);

      return toolResult({
        success: true,
        data: {
          operation: "concat",
          segment_count: segments.length,
          output: outputPath,
        },
        artifacts: [outputPath],
      });
    } finally {
      // Clean up temp segment files (but not the originals)
      for (const tf of tempFiles) {
        if (path.dirname(tf) === tempDir && fs.existsSync(tf)) {
          fs.unlinkSync(tf);
        }
      }
      if (fs.existsSync(listPath)) {
        fs.unlinkSync(listPath);
      }
      if (fs.existsSync(tempDir)) {
        try {
          fs.rmdirSync(tempDir);
        } catch {
          /* OSError: dir not empty — best effort */
        }
      }
    }
  }

  /** Build an atempo filter chain. atempo only accepts [0.5, 100.0]. */
  static _buildAtempoChain(factor: number): string {
    if (factor <= 0) {
      factor = 1.0;
    }
    // Chain multiple atempo filters for extreme values
    const filters: string[] = [];
    let remaining = factor;
    while (remaining > 100.0) {
      filters.push("atempo=100.0");
      remaining /= 100.0;
    }
    while (remaining < 0.5) {
      filters.push("atempo=0.5");
      remaining /= 0.5;
    }
    filters.push(`atempo=${remaining.toFixed(4)}`);
    return filters.join(",");
  }
}
