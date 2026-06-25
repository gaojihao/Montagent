/**
 * Silence cutter tool for automatic jump cuts.
 *
 * TypeScript port of tools/video/silence_cutter.py. Detects silent segments in
 * talking-head footage and removes them, creating tight jump cuts. Uses
 * FFmpeg's silencedetect filter — no external dependencies beyond FFmpeg.
 *
 * Modes:
 *   - remove: Cut out silent segments entirely (jump cut)
 *   - speed_up: Speed up silent segments instead of cutting (less jarring)
 *   - mark: Don't cut — just output silence timestamps for manual review
 *
 * Parity notes vs. Python:
 *  - silencedetect filter args, setpts/atempo strings, force_key_frames, and the
 *    concat demuxer list file format are copied verbatim.
 *  - Python read silencedetect output from result.stderr (ffmpeg logs the filter
 *    output to stderr even though `-f null -` exits 0). execa surfaces the same
 *    stderr on the resolved result, so we parse result.stderr directly. The
 *    Python except-branch that stringified the exception is preserved for the
 *    rare case ffmpeg exits non-zero (execa rejects -> we read err.stderr/message).
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

interface Silence {
  start: number;
  end: number;
  duration: number;
}
interface Segment {
  start: number;
  end: number;
}

/** Reproduce Python's Path.with_stem: replace the filename stem, keep dir + suffix. */
function withStem(p: string, newStem: string): string {
  const dir = path.dirname(p);
  const ext = path.extname(p);
  return path.join(dir, `${newStem}${ext}`);
}

/** Reproduce Python's Path.with_suffix: replace the extension. */
function withSuffix(p: string, newSuffix: string): string {
  const dir = path.dirname(p);
  const base = path.basename(p, path.extname(p));
  return path.join(dir, `${base}${newSuffix}`);
}

export class SilenceCutter extends BaseTool {
  override name = "silence_cutter";
  override version = "0.1.0";
  override tier = ToolTier.CORE;
  override capability = "video_post";
  override provider = "ffmpeg";
  override stability = ToolStability.EXPERIMENTAL;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;

  override dependencies = ["cmd:ffmpeg"];
  override install_instructions = "Install FFmpeg: https://ffmpeg.org/download.html";
  override agent_skills = ["ffmpeg"];

  override capabilities = [
    "silence_detection",
    "jump_cut",
    "silence_removal",
    "silence_speedup",
  ];

  override input_schema = {
    type: "object",
    required: ["input_path"],
    properties: {
      input_path: { type: "string" },
      output_path: { type: "string" },
      mode: {
        type: "string",
        enum: ["remove", "speed_up", "mark"],
        default: "remove",
        description: "remove=jump cut, speed_up=fast-forward silence, mark=detect only",
      },
      silence_threshold_db: {
        type: "number",
        default: -35,
        description:
          "Audio level below this (in dB) is considered silence. Lower = more sensitive.",
      },
      min_silence_duration: {
        type: "number",
        default: 0.5,
        minimum: 0.1,
        description: "Minimum silence duration in seconds to trigger a cut",
      },
      padding_seconds: {
        type: "number",
        default: 0.08,
        minimum: 0.0,
        description:
          "Seconds of silence to keep on each side of speech (prevents clipped words)",
      },
      silence_speed_factor: {
        type: "number",
        default: 6.0,
        minimum: 1.5,
        maximum: 100.0,
        description: "Speed multiplier for silent segments (only used in speed_up mode)",
      },
      codec: { type: "string", default: "libx264" },
      crf: { type: "integer", default: 18 },
    },
  };

  override resource_profile: ResourceProfile = {
    cpu_cores: 4,
    ram_mb: 2048,
    vram_mb: 0,
    disk_mb: 4000,
    network_required: false,
  };
  override retry_policy: RetryPolicy = {
    max_retries: 1,
    backoff_seconds: 1.0,
    retryable_errors: ["FFmpeg error"],
  };
  override resume_support = ResumeSupport.FROM_START;
  override idempotency_key_fields = [
    "input_path",
    "mode",
    "silence_threshold_db",
    "min_silence_duration",
    "padding_seconds",
  ];
  override side_effects = ["writes cut video to output_path"];
  override user_visible_verification = [
    "Watch output for unnaturally clipped words at cut points",
    "Compare duration: output should be noticeably shorter than input",
  ];

  override async execute(inputs: Record<string, any>): Promise<ToolResult> {
    const inputPath = inputs.input_path as string;
    if (!fs.existsSync(inputPath)) {
      return toolResult({ success: false, error: `Input not found: ${inputPath}` });
    }

    const mode = (inputs.mode as string) ?? "remove";
    const start = Date.now();

    // Step 1: Detect silence segments
    const thresholdDb = inputs.silence_threshold_db ?? -35;
    const minDur = inputs.min_silence_duration ?? 0.5;
    const padding = inputs.padding_seconds ?? 0.08;

    const silences = await this._detectSilence(inputPath, thresholdDb, minDur);

    if (silences.length === 0) {
      const elapsed = (Date.now() - start) / 1000;
      return toolResult({
        success: true,
        data: {
          message: "No silence detected — video unchanged",
          silence_segments: 0,
          input: inputPath,
          output: inputPath,
        },
        artifacts: [inputPath],
        duration_seconds: Math.round(elapsed * 100) / 100,
      });
    }

    // Get total duration
    const totalDuration = await this._getDuration(inputPath);

    // Step 2: Compute speech segments (inverse of silence)
    const speechSegments = this._computeSpeechSegments(silences, totalDuration, padding);

    // Step 3: Handle based on mode
    if (mode === "mark") {
      const elapsed = (Date.now() - start) / 1000;
      const outputJson =
        (inputs.output_path as string) ?? withSuffix(inputPath, ".silence.json");
      const silenceDuration = silences.reduce((acc, s) => acc + s.duration, 0);
      const speechDuration = speechSegments.reduce((acc, s) => acc + (s.end - s.start), 0);
      const resultData = {
        silences,
        speech_segments: speechSegments,
        total_duration: totalDuration,
        silence_duration: silenceDuration,
        speech_duration: speechDuration,
      };
      fs.mkdirSync(path.dirname(outputJson), { recursive: true });
      fs.writeFileSync(outputJson, JSON.stringify(resultData, null, 2), {
        encoding: "utf-8",
      });
      return toolResult({
        success: true,
        data: {
          mode: "mark",
          silence_segments: silences.length,
          speech_segments: speechSegments.length,
          silence_duration_seconds: Math.round(silenceDuration * 100) / 100,
          speech_duration_seconds: Math.round(speechDuration * 100) / 100,
          output: outputJson,
        },
        artifacts: [outputJson],
        duration_seconds: Math.round(elapsed * 100) / 100,
      });
    }

    const outputPath =
      (inputs.output_path as string) ??
      withStem(inputPath, `${path.basename(inputPath, path.extname(inputPath))}_cut`);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const codec = (inputs.codec as string) ?? "libx264";
    const crf = inputs.crf ?? 18;

    let result: ToolResult;
    if (mode === "speed_up") {
      const speedFactor = (inputs.silence_speed_factor as number) ?? 6.0;
      result = await this._renderSpeedUp(
        inputPath,
        outputPath,
        silences,
        speechSegments,
        totalDuration,
        speedFactor,
        codec,
        crf
      );
    } else {
      result = await this._renderJumpCut(inputPath, outputPath, speechSegments, codec, crf);
    }

    if (!result.success) {
      return result;
    }

    const elapsed = (Date.now() - start) / 1000;

    const silenceDur = silences.reduce((acc, s) => acc + s.duration, 0);
    const speechDur = speechSegments.reduce((acc, s) => acc + (s.end - s.start), 0);

    return toolResult({
      success: true,
      data: {
        mode,
        input: inputPath,
        output: outputPath,
        input_duration: Math.round(totalDuration * 100) / 100,
        output_duration: mode === "remove" ? Math.round(speechDur * 100) / 100 : null,
        silence_removed_seconds: Math.round(silenceDur * 100) / 100,
        silence_segments: silences.length,
        speech_segments: speechSegments.length,
        time_saved_percent:
          totalDuration > 0
            ? Math.round((silenceDur / totalDuration) * 100 * 10) / 10
            : 0,
      },
      artifacts: [outputPath],
      duration_seconds: Math.round(elapsed * 100) / 100,
    });
  }

  private async _detectSilence(
    inputPath: string,
    thresholdDb: number,
    minDuration: number
  ): Promise<Silence[]> {
    const cmd = [
      "ffmpeg",
      "-i",
      inputPath,
      "-af",
      `silencedetect=noise=${thresholdDb}dB:d=${minDuration}`,
      "-f",
      "null",
      "-",
    ];

    let output: string;
    try {
      // FFmpeg writes silencedetect results to stderr; `-f null -` exits 0.
      const result = await this.runCommand(cmd, { timeout: 300000 });
      output = String(result.stderr ?? "");
    } catch (e) {
      // FFmpeg writes to stderr even on success for filters
      const err = e as { stderr?: string; message?: string };
      output = err.stderr ?? err.message ?? String(e);
    }

    // Parse silencedetect output
    // Format: [silencedetect @ ...] silence_start: 1.234
    //         [silencedetect @ ...] silence_end: 2.567 | silence_duration: 1.333
    const starts = [...output.matchAll(/silence_start:\s*([\d.]+)/g)].map((m) => m[1]!);
    const ends = [...output.matchAll(/silence_end:\s*([\d.]+)/g)].map((m) => m[1]!);
    const durations = [...output.matchAll(/silence_duration:\s*([\d.]+)/g)].map((m) => m[1]!);

    const silences: Silence[] = [];
    const count = Math.min(starts.length, ends.length);
    for (let i = 0; i < count; i++) {
      silences.push({
        start: parseFloat(starts[i]!),
        end: parseFloat(ends[i]!),
        duration:
          i < durations.length
            ? parseFloat(durations[i]!)
            : parseFloat(ends[i]!) - parseFloat(starts[i]!),
      });
    }

    return silences;
  }

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
    try {
      const result = await this.runCommand(cmd);
      const data = JSON.parse(String(result.stdout)) as { format: { duration: string } };
      return parseFloat(data.format.duration);
    } catch {
      return 0.0;
    }
  }

  private _computeSpeechSegments(
    silences: Silence[],
    totalDuration: number,
    padding: number
  ): Segment[] {
    const segments: Segment[] = [];
    let cursor = 0.0;

    for (const silence of silences) {
      const speechEnd = silence.start + padding;
      if (speechEnd > cursor) {
        segments.push({ start: cursor, end: Math.min(speechEnd, totalDuration) });
      }
      cursor = Math.max(cursor, silence.end - padding);
    }

    // Final segment after last silence
    if (cursor < totalDuration) {
      segments.push({ start: cursor, end: totalDuration });
    }

    // Merge very short gaps (segments < 0.05s apart)
    const merged: Segment[] = [];
    for (const seg of segments) {
      if (seg.end - seg.start < 0.01) {
        continue; // Skip tiny segments
      }
      if (merged.length > 0 && seg.start - merged[merged.length - 1]!.end < 0.05) {
        merged[merged.length - 1]!.end = seg.end;
      } else {
        merged.push({ ...seg });
      }
    }

    return merged;
  }

  private async _renderJumpCut(
    inputPath: string,
    outputPath: string,
    speechSegments: Segment[],
    codec: string,
    crf: number
  ): Promise<ToolResult> {
    if (speechSegments.length === 0) {
      return toolResult({ success: false, error: "No speech segments found" });
    }

    const tempDir = path.join(path.dirname(outputPath), ".silence_cut_tmp");
    fs.mkdirSync(tempDir, { recursive: true });

    try {
      // Cut each speech segment
      const segFiles: string[] = [];
      for (let i = 0; i < speechSegments.length; i++) {
        const seg = speechSegments[i]!;
        const segPath = path.join(tempDir, `seg_${String(i).padStart(4, "0")}.mp4`);
        const cmd = [
          "ffmpeg",
          "-y",
          "-i",
          inputPath,
          "-ss",
          seg.start.toFixed(3),
          "-to",
          seg.end.toFixed(3),
          "-c:v",
          codec,
          "-crf",
          String(crf),
          "-preset",
          "fast",
          "-c:a",
          "aac",
          "-b:a",
          "192k",
          // Force keyframe at start for clean cuts
          "-force_key_frames",
          seg.start.toFixed(3),
          segPath,
        ];
        await this.runCommand(cmd, { timeout: 120000 });
        if (fs.existsSync(segPath) && fs.statSync(segPath).size > 0) {
          segFiles.push(segPath);
        }
      }

      if (segFiles.length === 0) {
        return toolResult({ success: false, error: "No segments were successfully cut" });
      }

      // Concat all segments
      const listPath = path.join(tempDir, "concat_list.txt");
      const lines = segFiles
        .map((sf) => `file '${path.resolve(sf).replace(/\\/g, "/")}'\n`)
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
      await this.runCommand(cmd, { timeout: 120000 });

      return toolResult({ success: true });
    } catch (e) {
      return toolResult({ success: false, error: `Jump cut render failed: ${(e as Error).message ?? e}` });
    } finally {
      // Clean up temp files
      this._cleanupTempDir(tempDir);
    }
  }

  private async _renderSpeedUp(
    inputPath: string,
    outputPath: string,
    silences: Silence[],
    speechSegments: Segment[],
    _totalDuration: number,
    speedFactor: number,
    codec: string,
    crf: number
  ): Promise<ToolResult> {
    const tempDir = path.join(path.dirname(outputPath), ".silence_speed_tmp");
    fs.mkdirSync(tempDir, { recursive: true });

    try {
      // Build a timeline of segments: speech at 1x, silence at Nx
      const allSegments: Array<{ start: number; end: number; speed: number }> = [];

      for (const seg of speechSegments) {
        allSegments.push({ start: seg.start, end: seg.end, speed: 1.0 });
      }

      for (const sil of silences) {
        allSegments.push({ start: sil.start, end: sil.end, speed: speedFactor });
      }

      // Sort by start time and merge overlaps
      allSegments.sort((a, b) => a.start - b.start);

      // Process each segment
      const segFiles: string[] = [];
      for (let i = 0; i < allSegments.length; i++) {
        const seg = allSegments[i]!;
        const segPath = path.join(tempDir, `seg_${String(i).padStart(4, "0")}.mp4`);
        const duration = seg.end - seg.start;
        if (duration < 0.05) {
          continue;
        }

        let cmd: string[];
        if (seg.speed === 1.0) {
          // Normal speed
          cmd = [
            "ffmpeg",
            "-y",
            "-i",
            inputPath,
            "-ss",
            seg.start.toFixed(3),
            "-to",
            seg.end.toFixed(3),
            "-c:v",
            codec,
            "-crf",
            String(crf),
            "-preset",
            "fast",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            segPath,
          ];
        } else {
          // Speed up
          const pts = 1.0 / seg.speed;
          const atempoChain = SilenceCutter._buildAtempoChain(seg.speed);
          cmd = [
            "ffmpeg",
            "-y",
            "-i",
            inputPath,
            "-ss",
            seg.start.toFixed(3),
            "-to",
            seg.end.toFixed(3),
            "-filter:v",
            `setpts=${pts.toFixed(4)}*PTS`,
            "-filter:a",
            atempoChain,
            "-c:v",
            codec,
            "-crf",
            String(crf),
            "-preset",
            "fast",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            segPath,
          ];
        }

        await this.runCommand(cmd, { timeout: 120000 });
        if (fs.existsSync(segPath) && fs.statSync(segPath).size > 0) {
          segFiles.push(segPath);
        }
      }

      if (segFiles.length === 0) {
        return toolResult({ success: false, error: "No segments rendered" });
      }

      // Concat
      const listPath = path.join(tempDir, "concat_list.txt");
      const lines = segFiles
        .map((sf) => `file '${path.resolve(sf).replace(/\\/g, "/")}'\n`)
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
      await this.runCommand(cmd, { timeout: 120000 });

      return toolResult({ success: true });
    } catch (e) {
      return toolResult({ success: false, error: `Speed-up render failed: ${(e as Error).message ?? e}` });
    } finally {
      this._cleanupTempDir(tempDir);
    }
  }

  /** Clean up a temp dir: unlink all files, then rmdir (best-effort). */
  private _cleanupTempDir(tempDir: string): void {
    try {
      for (const f of fs.readdirSync(tempDir)) {
        try {
          fs.unlinkSync(path.join(tempDir, f));
        } catch {
          /* OSError — best effort */
        }
      }
    } catch {
      /* dir gone */
    }
    try {
      fs.rmdirSync(tempDir);
    } catch {
      /* OSError — best effort */
    }
  }

  /** Build atempo filter chain. atempo accepts [0.5, 100.0]. */
  static _buildAtempoChain(factor: number): string {
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

  override estimateRuntime(_inputs: Record<string, unknown>): number {
    return 45.0;
  }
}
