/**
 * Video stitch tool wrapping FFmpeg.
 *
 * TypeScript port of tools/video/video_stitch.py. Multi-clip assembly with
 * validation, transitions, and spatial layouts. Supports sequential
 * concatenation (TikTok-style stitch), crossfade/fade transitions, and spatial
 * compositions (side-by-side, vertical stack, picture-in-picture) for
 * duet-style content.
 *
 * Parity notes vs. Python:
 *  - All ffprobe/ffmpeg argument arrays, the filter_complex strings (xfade,
 *    acrossfade, hstack, vstack, overlay, amix, anullsrc, scale/pad), the concat
 *    demuxer list file format, and the cumulative xfade offset math are copied
 *    verbatim.
 *  - lib.media_profiles.get_profile is reproduced as a small inline registry
 *    (the TS port has no lib/media_profiles module). Python wrapped get_profile
 *    in try/except (ImportError, ValueError): pass — an unknown profile here
 *    returns null and falls through identically.
 *  - subprocess.run -> this.runCommand (execa); on failure execa rejects, which
 *    propagates exactly like the Python exception bubbling to execute()/_spatial.
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

// ---------------------------------------------------------------------------
// Minimal media-profile registry (port of the fields lib/media_profiles.py
// exposes that _resolve_normalization_target uses: width/height/fps/codec/
// audio_codec). Kept inline because the TS port has no lib/media_profiles
// module and the data is small and stable.
// ---------------------------------------------------------------------------
interface MediaProfile {
  name: string;
  width: number;
  height: number;
  fps: number;
  codec: string;
  audio_codec: string;
}

const MEDIA_PROFILES: Record<string, MediaProfile> = {
  youtube_landscape: { name: "youtube_landscape", width: 1920, height: 1080, fps: 30, codec: "libx264", audio_codec: "aac" },
  youtube_4k: { name: "youtube_4k", width: 3840, height: 2160, fps: 30, codec: "libx264", audio_codec: "aac" },
  youtube_shorts: { name: "youtube_shorts", width: 1080, height: 1920, fps: 30, codec: "libx264", audio_codec: "aac" },
  instagram_reels: { name: "instagram_reels", width: 1080, height: 1920, fps: 30, codec: "libx264", audio_codec: "aac" },
  instagram_feed: { name: "instagram_feed", width: 1080, height: 1080, fps: 30, codec: "libx264", audio_codec: "aac" },
  tiktok: { name: "tiktok", width: 1080, height: 1920, fps: 30, codec: "libx264", audio_codec: "aac" },
  linkedin: { name: "linkedin", width: 1920, height: 1080, fps: 30, codec: "libx264", audio_codec: "aac" },
  cinematic: { name: "cinematic", width: 2560, height: 1080, fps: 24, codec: "libx264", audio_codec: "aac" },
  generic_hd: { name: "generic_hd", width: 1920, height: 1080, fps: 30, codec: "libx264", audio_codec: "aac" },
};

/** Resolve a media profile by name, or null if unknown (mirrors Python's
 * get_profile raising ValueError → caught by the try/except caller). */
function getProfile(name: string): MediaProfile | null {
  return MEDIA_PROFILES[name] ?? null;
}

interface ProbeInfo {
  path: string;
  width?: number | null;
  height?: number | null;
  video_codec?: string | null;
  pixel_format?: string | null;
  fps?: number | null;
  audio_codec?: string | null;
  sample_rate?: string | null;
  audio_channels?: number | null;
  duration?: number;
  file_size_bytes?: number;
}

export class VideoStitch extends BaseTool {
  override name = "video_stitch";
  override version = "0.1.0";
  override tier = ToolTier.CORE;
  override capability = "video_post";
  override provider = "ffmpeg";
  override stability = ToolStability.EXPERIMENTAL;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;

  override dependencies = ["cmd:ffmpeg", "cmd:ffprobe"];
  override install_instructions =
    "Install FFmpeg: https://ffmpeg.org/download.html\n" +
    "Windows: winget install FFmpeg\n" +
    "macOS: brew install ffmpeg\n" +
    "Linux: sudo apt install ffmpeg";
  override agent_skills = ["ffmpeg", "video_toolkit"];

  override capabilities = [
    "validate_clips",
    "stitch",
    "crossfade",
    "fade_through_black",
    "preview_stitch",
    "spatial_side_by_side",
    "spatial_vertical_stack",
    "spatial_picture_in_picture",
  ];

  override input_schema = {
    type: "object",
    required: ["operation"],
    properties: {
      operation: {
        type: "string",
        enum: ["validate", "stitch", "preview_stitch", "spatial"],
      },
      clips: {
        type: "array",
        items: { type: "string" },
        description: "List of input video file paths",
      },
      output_path: { type: "string" },
      transition: {
        type: "string",
        enum: ["cut", "crossfade", "fade"],
        default: "cut",
        description: "Transition type: cut (default), crossfade, or fade (fade-through-black)",
      },
      transition_duration: {
        type: "number",
        minimum: 0.1,
        maximum: 5.0,
        default: 0.5,
        description: "Transition duration in seconds",
      },
      auto_normalize: {
        type: "boolean",
        default: false,
        description: "Re-encode clips to a common format before concat if they differ",
      },
      target_resolution: {
        type: "string",
        description: "Target resolution for normalization (e.g. '1920x1080')",
      },
      target_fps: {
        type: "integer",
        description: "Target FPS for normalization",
      },
      codec: { type: "string", default: "libx264" },
      crf: { type: "integer", default: 23 },
      preset: { type: "string", default: "medium" },
      profile: {
        type: "string",
        description: "Media profile name from media_profiles.py",
      },
      layout: {
        type: "string",
        enum: ["side_by_side", "vertical_stack", "picture_in_picture"],
        description: "Spatial layout for the spatial operation",
      },
      pip_position: {
        type: "string",
        enum: ["top_left", "top_right", "bottom_left", "bottom_right"],
        default: "bottom_right",
        description: "Position of the PiP overlay",
      },
      pip_scale: {
        type: "number",
        minimum: 0.1,
        maximum: 0.5,
        default: 0.3,
        description: "Scale of PiP overlay relative to base video",
      },
      pip_margin: {
        type: "integer",
        default: 10,
        description: "Margin in pixels for PiP overlay from edges",
      },
      dry_run: {
        type: "boolean",
        default: false,
        description: "If true, return what would be done without executing",
      },
    },
  };

  override resource_profile: ResourceProfile = {
    cpu_cores: 4,
    ram_mb: 2048,
    vram_mb: 0,
    disk_mb: 5000,
    network_required: false,
  };
  override retry_policy: RetryPolicy = {
    max_retries: 1,
    backoff_seconds: 1.0,
    retryable_errors: ["Conversion failed"],
  };
  override resume_support = ResumeSupport.FROM_START;
  override idempotency_key_fields = ["operation", "clips", "transition", "layout"];
  override side_effects = ["writes video file to output_path"];
  override user_visible_verification = [
    "Play the stitched output and verify clip ordering, transitions, and A/V sync",
  ];

  override async execute(inputs: Record<string, any>): Promise<ToolResult> {
    const operation = inputs.operation as string;
    const start = Date.now();

    if (inputs.dry_run) {
      return toolResult({
        success: true,
        data: await this.dryRunAsync(inputs),
      });
    }

    let result: ToolResult;
    try {
      if (operation === "validate") {
        result = await this._validate(inputs);
      } else if (operation === "stitch") {
        result = await this._stitch(inputs);
      } else if (operation === "preview_stitch") {
        result = await this._previewStitch(inputs);
      } else if (operation === "spatial") {
        result = await this._spatial(inputs);
      } else {
        return toolResult({ success: false, error: `Unknown operation: ${operation}` });
      }
    } catch (e) {
      return toolResult({ success: false, error: `${(e as Error).message ?? e}` });
    }

    result.duration_seconds = Math.round((Date.now() - start) / 10) / 100;
    return result;
  }

  /** Preflight check: validate clips and report what would happen.
   * Async port of the Python dry_run (which probed clips synchronously). */
  async dryRunAsync(inputs: Record<string, any>): Promise<Record<string, unknown>> {
    const clips = (inputs.clips as string[]) ?? [];
    const operation = (inputs.operation as string) ?? "stitch";
    const info: Record<string, unknown> = {
      tool: this.name,
      operation,
      clip_count: clips.length,
      transition: (inputs.transition as string) ?? "cut",
      auto_normalize: inputs.auto_normalize ?? false,
      estimated_cost_usd: this.estimateCost(inputs),
      estimated_runtime_seconds: this.estimateRuntime(inputs),
      status: this.getStatus(),
      would_execute: true,
    };
    if (clips.length > 0) {
      const probeResults: ProbeInfo[] = [];
      for (const clip of clips) {
        if (fs.existsSync(clip)) {
          const probe = await this._probeClip(clip);
          if (probe) {
            probeResults.push(probe);
          }
        }
      }
      info.clip_info = probeResults;
    }
    return info;
  }

  // ------------------------------------------------------------------
  // Audio-stream detection and silent-audio helpers
  // ------------------------------------------------------------------

  private async _clipHasAudio(clipPath: string): Promise<boolean> {
    // Return True if clipPath contains at least one audio stream.
    const cmd = [
      "ffprobe",
      "-v",
      "quiet",
      "-select_streams",
      "a",
      "-show_entries",
      "stream=codec_type",
      "-of",
      "json",
      clipPath,
    ];
    try {
      const proc = await this.runCommand(cmd);
      const data = JSON.parse(String(proc.stdout)) as { streams?: unknown[] };
      return (data.streams ?? []).length > 0;
    } catch {
      return false;
    }
  }

  private async _ensureAudioForClips(
    clips: string[],
    tempDir: string,
    tempFiles: string[]
  ): Promise<string[]> {
    // Return a list of clip paths where every clip is guaranteed to have an
    // audio stream. Clips that already contain audio are returned as-is. For
    // clips without audio, a silent stereo AAC track is muxed in.
    const result: string[] = [];
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i]!;
      if (await this._clipHasAudio(clip)) {
        result.push(clip);
      } else {
        const augmented = path.join(tempDir, `audio_aug_${String(i).padStart(4, "0")}.mp4`);
        const cmd = [
          "ffmpeg",
          "-y",
          "-i",
          clip,
          "-f",
          "lavfi",
          "-i",
          "anullsrc=r=44100:cl=stereo",
          "-c:v",
          "copy",
          "-c:a",
          "aac",
          "-shortest",
          augmented,
        ];
        await this.runCommand(cmd);
        tempFiles.push(augmented);
        result.push(augmented);
      }
    }
    return result;
  }

  // ------------------------------------------------------------------
  // Probe helper
  // ------------------------------------------------------------------

  private async _probeClip(clipPath: string): Promise<ProbeInfo | null> {
    // Probe a single clip with ffprobe and return metadata dict.
    const cmd = [
      "ffprobe",
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_streams",
      "-show_format",
      clipPath,
    ];
    let data: { streams?: Array<Record<string, any>>; format?: Record<string, any> };
    try {
      const proc = await this.runCommand(cmd);
      data = JSON.parse(String(proc.stdout));
    } catch {
      return null;
    }

    const info: ProbeInfo = { path: clipPath };

    // Extract video stream info
    for (const stream of data.streams ?? []) {
      if (stream.codec_type === "video") {
        info.width = stream.width;
        info.height = stream.height;
        info.video_codec = stream.codec_name;
        info.pixel_format = stream.pix_fmt;
        // Parse fps from r_frame_rate (e.g. "30/1")
        const rfr = (stream.r_frame_rate as string) ?? "0/1";
        try {
          const [num, den] = rfr.split("/");
          const denN = parseInt(den!, 10);
          if (denN === 0) throw new Error("ZeroDivisionError");
          info.fps = Math.round((parseInt(num!, 10) / denN) * 100) / 100;
        } catch {
          info.fps = null;
        }
        break;
      }
    }

    // Extract audio stream info
    for (const stream of data.streams ?? []) {
      if (stream.codec_type === "audio") {
        info.audio_codec = stream.codec_name;
        info.sample_rate = stream.sample_rate;
        info.audio_channels = stream.channels;
        break;
      }
    }

    // Duration from format
    const fmt = data.format ?? {};
    const durRaw = fmt.duration;
    const durNum = parseFloat(durRaw);
    info.duration = Number.isFinite(durNum) ? durNum : 0.0;
    const sizeNum = parseInt(fmt.size, 10);
    info.file_size_bytes = Number.isFinite(sizeNum) ? sizeNum : 0;

    return info;
  }

  // ------------------------------------------------------------------
  // validate
  // ------------------------------------------------------------------

  private async _validate(inputs: Record<string, any>): Promise<ToolResult> {
    // Check clip compatibility: resolution, fps, codec, audio format.
    const clips = (inputs.clips as string[]) ?? [];
    if (clips.length === 0) {
      return toolResult({ success: false, error: "No clips provided" });
    }

    // Probe all clips
    const probes: ProbeInfo[] = [];
    const missing: string[] = [];
    const probeErrors: string[] = [];

    for (const clip of clips) {
      if (!fs.existsSync(clip)) {
        missing.push(clip);
        continue;
      }
      const info = await this._probeClip(clip);
      if (info === null) {
        probeErrors.push(clip);
      } else {
        probes.push(info);
      }
    }

    if (missing.length > 0) {
      return toolResult({ success: false, error: `Clips not found: ${missing.join(", ")}` });
    }
    if (probeErrors.length > 0) {
      return toolResult({ success: false, error: `Failed to probe clips: ${probeErrors.join(", ")}` });
    }

    // Compare properties across clips
    const mismatches: Array<Record<string, any>> = [];
    const reference = probes[0]!;
    const checkFields: Array<[keyof ProbeInfo, string]> = [
      ["width", "resolution width"],
      ["height", "resolution height"],
      ["fps", "frame rate"],
      ["video_codec", "video codec"],
      ["pixel_format", "pixel format"],
      ["audio_codec", "audio codec"],
      ["sample_rate", "audio sample rate"],
      ["audio_channels", "audio channels"],
    ];

    for (let i = 1; i < probes.length; i++) {
      const probe = probes[i]!;
      const clipMismatches: string[] = [];
      for (const [fieldKey, label] of checkFields) {
        const refVal = reference[fieldKey];
        const curVal = probe[fieldKey];
        if (
          refVal !== null &&
          refVal !== undefined &&
          curVal !== null &&
          curVal !== undefined &&
          refVal !== curVal
        ) {
          clipMismatches.push(`${label}: clip[0]=${refVal} vs clip[${i}]=${curVal}`);
        }
      }
      if (clipMismatches.length > 0) {
        mismatches.push({
          clip_index: i,
          clip_path: probe.path,
          differences: clipMismatches,
        });
      }
    }

    const compatible = mismatches.length === 0;
    const totalDuration = probes.reduce((acc, p) => acc + (p.duration ?? 0), 0);

    return toolResult({
      success: true,
      data: {
        operation: "validate",
        clip_count: clips.length,
        compatible,
        total_duration: Math.round(totalDuration * 100) / 100,
        reference_clip: {
          path: reference.path,
          resolution: `${reference.width}x${reference.height}`,
          fps: reference.fps,
          video_codec: reference.video_codec,
          audio_codec: reference.audio_codec,
        },
        mismatches,
        clips: probes,
      },
    });
  }

  // ------------------------------------------------------------------
  // Normalization helper
  // ------------------------------------------------------------------

  private _resolveNormalizationTarget(
    inputs: Record<string, any>,
    probes: ProbeInfo[]
  ): [number, number, number, string, string] {
    // Determine the target resolution, fps, and codecs for normalization.
    // If a media profile is specified, use it
    const profileName = inputs.profile as string | undefined;
    if (profileName) {
      const profile = getProfile(profileName);
      if (profile) {
        return [profile.width, profile.height, profile.fps, profile.codec, profile.audio_codec];
      }
      // Unknown profile -> fall through (mirrors except (ImportError, ValueError): pass)
    }

    // Explicit target overrides
    let targetW: number | null = null;
    let targetH: number | null = null;
    if (inputs.target_resolution) {
      const parts = (inputs.target_resolution as string).split("x");
      if (parts.length === 2) {
        targetW = parseInt(parts[0]!, 10);
        targetH = parseInt(parts[1]!, 10);
      }
    }

    const targetFps = inputs.target_fps as number | undefined;

    // Fall back to first clip as reference
    const ref = probes.length > 0 ? probes[0]! : ({} as ProbeInfo);
    const width = targetW || ref.width || 1920;
    const height = targetH || ref.height || 1080;
    const fps = targetFps || ref.fps || 30;
    const videoCodec = (inputs.codec as string) ?? "libx264";
    const audioCodec = "aac";

    return [width, height, Math.trunc(fps), videoCodec, audioCodec];
  }

  private async _normalizeClip(
    clipPath: string,
    outputPath: string,
    width: number,
    height: number,
    fps: number,
    videoCodec: string,
    audioCodec: string,
    crf: number,
    preset: string
  ): Promise<void> {
    // Re-encode a clip to the target format.
    const cmd = [
      "ffmpeg",
      "-y",
      "-i",
      clipPath,
      "-vf",
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
      "-r",
      String(fps),
      "-c:v",
      videoCodec,
      "-crf",
      String(crf),
      "-preset",
      preset,
      "-c:a",
      audioCodec,
      "-ar",
      "44100",
      "-ac",
      "2",
      "-pix_fmt",
      "yuv420p",
      outputPath,
    ];
    await this.runCommand(cmd);
  }

  private _needsNormalization(probes: ProbeInfo[]): boolean {
    // Check whether clips need normalization to be concat-compatible.
    if (probes.length < 2) {
      return false;
    }
    const ref = probes[0]!;
    const keys: Array<keyof ProbeInfo> = [
      "width",
      "height",
      "fps",
      "video_codec",
      "audio_codec",
      "sample_rate",
    ];
    for (let i = 1; i < probes.length; i++) {
      const probe = probes[i]!;
      for (const key of keys) {
        if (ref[key] !== probe[key] && ref[key] !== null && ref[key] !== undefined) {
          return true;
        }
      }
    }
    return false;
  }

  // ------------------------------------------------------------------
  // stitch
  // ------------------------------------------------------------------

  private async _stitch(inputs: Record<string, any>): Promise<ToolResult> {
    // Concatenate clips sequentially with FFmpeg concat demuxer.
    const clips = (inputs.clips as string[]) ?? [];
    if (clips.length === 0) {
      return toolResult({ success: false, error: "No clips provided" });
    }
    if (clips.length < 2) {
      return toolResult({ success: false, error: "At least 2 clips required for stitch" });
    }

    const outputPath = (inputs.output_path as string) ?? "stitched_output.mp4";
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const transition = (inputs.transition as string) ?? "cut";
    const transitionDur = (inputs.transition_duration as number) ?? 0.5;
    const autoNormalize = inputs.auto_normalize ?? false;
    const codec = (inputs.codec as string) ?? "libx264";
    const crf = inputs.crf ?? 23;
    const preset = (inputs.preset as string) ?? "medium";

    // Verify all clips exist
    for (const clip of clips) {
      if (!fs.existsSync(clip)) {
        return toolResult({ success: false, error: `Clip not found: ${clip}` });
      }
    }

    // Probe clips for compatibility check
    const probes: ProbeInfo[] = [];
    for (const clip of clips) {
      const info = await this._probeClip(clip);
      if (info === null) {
        return toolResult({ success: false, error: `Failed to probe clip: ${clip}` });
      }
      probes.push(info);
    }

    const needsNorm = this._needsNormalization(probes);

    // If clips are incompatible and auto_normalize is off, fail with advice
    if (needsNorm && !autoNormalize && transition === "cut") {
      return toolResult({
        success: false,
        error:
          "Clips have mismatched properties (resolution/fps/codec). " +
          "Set auto_normalize=true to re-encode to a common format, " +
          "or use a transition type other than 'cut'.",
      });
    }

    const tempDir = path.join(path.dirname(outputPath), ".stitch_tmp");
    fs.mkdirSync(tempDir, { recursive: true });
    const tempFiles: string[] = [];

    try {
      // Normalize clips if needed
      let workingClips: string[];
      if (needsNorm || autoNormalize || transition !== "cut") {
        const [width, height, fps, vidCodec, audCodec] = this._resolveNormalizationTarget(
          inputs,
          probes
        );
        workingClips = [];
        for (let i = 0; i < clips.length; i++) {
          const clip = clips[i]!;
          const normPath = path.join(tempDir, `norm_${String(i).padStart(4, "0")}.mp4`);
          await this._normalizeClip(
            clip,
            normPath,
            width,
            height,
            fps,
            vidCodec,
            audCodec,
            crf,
            preset
          );
          workingClips.push(normPath);
          tempFiles.push(normPath);
        }
      } else {
        workingClips = [...clips];
      }

      // For crossfade/fade transitions, ensure every clip has an audio stream
      // so that the acrossfade filter does not fail.
      if (transition === "crossfade" || transition === "fade") {
        workingClips = await this._ensureAudioForClips(workingClips, tempDir, tempFiles);
      }

      let resultData: Record<string, any>;
      if (transition === "cut") {
        resultData = await this._stitchCut(workingClips, outputPath, tempDir, tempFiles);
      } else if (transition === "crossfade") {
        resultData = await this._stitchCrossfade(workingClips, outputPath, transitionDur, probes);
      } else if (transition === "fade") {
        resultData = await this._stitchFadeThroughBlack(
          workingClips,
          outputPath,
          transitionDur,
          probes
        );
      } else {
        return toolResult({ success: false, error: `Unknown transition type: ${transition}` });
      }

      // Get output file info
      const fileSize = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
      const outProbe = await this._probeClip(outputPath);
      const outDuration = outProbe ? (outProbe.duration ?? 0) : 0;

      return toolResult({
        success: true,
        data: {
          operation: "stitch",
          clip_count: clips.length,
          transition,
          transition_duration: transition !== "cut" ? transitionDur : 0,
          auto_normalized: needsNorm || autoNormalize,
          output: outputPath,
          duration: Math.round(outDuration * 100) / 100,
          file_size_bytes: fileSize,
          ...resultData,
        },
        artifacts: [outputPath],
      });
    } finally {
      VideoStitch._cleanupTemp(tempDir, tempFiles);
    }
  }

  private async _stitchCut(
    clips: string[],
    outputPath: string,
    tempDir: string,
    tempFiles: string[]
  ): Promise<Record<string, any>> {
    // Simple concat via FFmpeg concat demuxer (no transition).
    const concatList = path.join(tempDir, "concat_list.txt");
    tempFiles.push(concatList);
    const lines = clips
      .map((clip) => `file '${path.resolve(clip).replace(/\\/g, "/")}'\n`)
      .join("");
    fs.writeFileSync(concatList, lines, { encoding: "utf-8" });

    const cmd = [
      "ffmpeg",
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatList,
      "-c",
      "copy",
      outputPath,
    ];
    await this.runCommand(cmd);
    return { method: "concat_demuxer" };
  }

  private async _stitchCrossfade(
    clips: string[],
    outputPath: string,
    duration: number,
    probes: ProbeInfo[]
  ): Promise<Record<string, any>> {
    // Crossfade between adjacent clips using xfade filter.
    if (clips.length === 2) {
      // Simple two-clip crossfade
      const cmd = [
        "ffmpeg",
        "-y",
        "-i",
        clips[0]!,
        "-i",
        clips[1]!,
        "-filter_complex",
        `[0:v][1:v]xfade=transition=fade:duration=${duration}:offset=${this._getXfadeOffset(probes, 0, duration)}[v];` +
          `[0:a][1:a]acrossfade=d=${duration}[a]`,
        "-map",
        "[v]",
        "-map",
        "[a]",
        outputPath,
      ];
      await this.runCommand(cmd);
    } else {
      // Chain crossfades for N clips
      await this._chainXfade(clips, outputPath, duration, probes, "fade");
    }
    return { method: "xfade_crossfade" };
  }

  private async _stitchFadeThroughBlack(
    clips: string[],
    outputPath: string,
    duration: number,
    probes: ProbeInfo[]
  ): Promise<Record<string, any>> {
    // Fade-through-black between adjacent clips using xfade fadeblack.
    if (clips.length === 2) {
      const cmd = [
        "ffmpeg",
        "-y",
        "-i",
        clips[0]!,
        "-i",
        clips[1]!,
        "-filter_complex",
        `[0:v][1:v]xfade=transition=fadeblack:duration=${duration}:offset=${this._getXfadeOffset(probes, 0, duration)}[v];` +
          `[0:a][1:a]acrossfade=d=${duration}[a]`,
        "-map",
        "[v]",
        "-map",
        "[a]",
        outputPath,
      ];
      await this.runCommand(cmd);
    } else {
      await this._chainXfade(clips, outputPath, duration, probes, "fadeblack");
    }
    return { method: "xfade_fadeblack" };
  }

  private _getXfadeOffset(probes: ProbeInfo[], clipIndex: number, duration: number): number {
    // Calculate xfade offset for a given clip pair.
    const clipDur = clipIndex < probes.length ? (probes[clipIndex]!.duration ?? 0) : 0;
    const offset = Math.max(0, clipDur - duration);
    return Math.round(offset * 1000) / 1000;
  }

  private async _chainXfade(
    clips: string[],
    outputPath: string,
    duration: number,
    probes: ProbeInfo[],
    transition: string
  ): Promise<void> {
    // Chain xfade filters for N > 2 clips.
    const n = clips.length;
    const inputArgs: string[] = [];
    for (const clip of clips) {
      inputArgs.push("-i", clip);
    }

    // Calculate cumulative offsets
    const videoFilters: string[] = [];
    const audioFilters: string[] = [];
    let cumulativeOffset = 0.0;

    for (let i = 0; i < n - 1; i++) {
      const clipDur = i < probes.length ? (probes[i]!.duration ?? 0) : 0;
      let offset = Math.round((cumulativeOffset + clipDur - duration) * 1000) / 1000;
      offset = Math.max(0, offset);

      let vIn1: string;
      let aIn1: string;
      if (i === 0) {
        vIn1 = "[0:v]";
        aIn1 = "[0:a]";
      } else {
        vIn1 = `[vfade${i - 1}]`;
        aIn1 = `[afade${i - 1}]`;
      }

      const vIn2 = `[${i + 1}:v]`;
      const aIn2 = `[${i + 1}:a]`;

      let vOut: string;
      let aOut: string;
      if (i < n - 2) {
        vOut = `[vfade${i}]`;
        aOut = `[afade${i}]`;
      } else {
        vOut = "[vout]";
        aOut = "[aout]";
      }

      videoFilters.push(
        `${vIn1}${vIn2}xfade=transition=${transition}:duration=${duration}:offset=${offset}${vOut}`
      );
      audioFilters.push(`${aIn1}${aIn2}acrossfade=d=${duration}${aOut}`);

      // Cumulative offset advances by clip duration minus overlap
      cumulativeOffset = offset;
    }

    const filterComplex = [...videoFilters, ...audioFilters].join(";");

    const cmd = ["ffmpeg", "-y"];
    cmd.push(...inputArgs);
    cmd.push("-filter_complex", filterComplex);
    cmd.push("-map", "[vout]", "-map", "[aout]");
    cmd.push(outputPath);
    await this.runCommand(cmd);
  }

  // ------------------------------------------------------------------
  // preview_stitch
  // ------------------------------------------------------------------

  private async _previewStitch(inputs: Record<string, any>): Promise<ToolResult> {
    // Generate a low-resolution preview of the stitched result.
    const clips = (inputs.clips as string[]) ?? [];
    if (clips.length === 0) {
      return toolResult({ success: false, error: "No clips provided" });
    }
    if (clips.length < 2) {
      return toolResult({ success: false, error: "At least 2 clips required for preview" });
    }

    const outputPath = (inputs.output_path as string) ?? "stitch_preview.mp4";
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    // Verify all clips exist
    for (const clip of clips) {
      if (!fs.existsSync(clip)) {
        return toolResult({ success: false, error: `Clip not found: ${clip}` });
      }
    }

    // Build preview by normalizing to low-res and stitching
    const previewInputs = { ...inputs };
    previewInputs.auto_normalize = true;
    previewInputs.target_resolution = "640x360";
    previewInputs.target_fps = 24;
    previewInputs.crf = 30;
    previewInputs.preset = "ultrafast";
    previewInputs.output_path = outputPath;

    // Delegate to _stitch with preview settings
    const result = await this._stitch(previewInputs);

    if (result.success) {
      result.data = result.data ?? {};
      result.data.operation = "preview_stitch";
      result.data.preview = true;
      result.data.preview_resolution = "640x360";
    }

    return result;
  }

  // ------------------------------------------------------------------
  // spatial
  // ------------------------------------------------------------------

  private async _spatial(inputs: Record<string, any>): Promise<ToolResult> {
    // Side-by-side, vertical stack, or picture-in-picture layouts.
    const clips = (inputs.clips as string[]) ?? [];
    if (clips.length === 0 || clips.length < 2) {
      return toolResult({ success: false, error: "At least 2 clips required for spatial layout" });
    }

    const layout = inputs.layout as string | undefined;
    if (!layout) {
      return toolResult({ success: false, error: "layout is required for spatial operation" });
    }

    const outputPath = (inputs.output_path as string) ?? "spatial_output.mp4";
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const codec = (inputs.codec as string) ?? "libx264";
    const crf = inputs.crf ?? 23;

    // Verify all clips exist
    for (const clip of clips) {
      if (!fs.existsSync(clip)) {
        return toolResult({ success: false, error: `Clip not found: ${clip}` });
      }
    }

    const tempDir = path.join(path.dirname(outputPath), ".spatial_tmp");
    fs.mkdirSync(tempDir, { recursive: true });
    const tempFiles: string[] = [];

    try {
      // side_by_side and vertical_stack use amix which requires audio on both
      // inputs. Ensure silent tracks for audio-less clips.
      let workingClips = [...clips];
      if (layout === "side_by_side" || layout === "vertical_stack") {
        workingClips = await this._ensureAudioForClips(workingClips, tempDir, tempFiles);
      }

      if (layout === "side_by_side") {
        await this._spatialSideBySide(workingClips, outputPath, codec, crf);
      } else if (layout === "vertical_stack") {
        await this._spatialVerticalStack(workingClips, outputPath, codec, crf);
      } else if (layout === "picture_in_picture") {
        await this._spatialPip(workingClips, outputPath, inputs, codec, crf);
      } else {
        return toolResult({ success: false, error: `Unknown layout: ${layout}` });
      }
    } catch (e) {
      return toolResult({ success: false, error: `${(e as Error).message ?? e}` });
    } finally {
      VideoStitch._cleanupTemp(tempDir, tempFiles);
    }

    const fileSize = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
    const outProbe = await this._probeClip(outputPath);
    const outDuration = outProbe ? (outProbe.duration ?? 0) : 0;

    return toolResult({
      success: true,
      data: {
        operation: "spatial",
        layout,
        clip_count: clips.length,
        output: outputPath,
        duration: Math.round(outDuration * 100) / 100,
        file_size_bytes: fileSize,
      },
      artifacts: [outputPath],
    });
  }

  private async _spatialSideBySide(
    clips: string[],
    outputPath: string,
    codec: string,
    crf: number
  ): Promise<void> {
    // Place clips side by side (horizontal split).
    const inputArgs = ["-i", clips[0]!, "-i", clips[1]!];
    const filterComplex =
      "[0:v]scale=-2:480[left];" +
      "[1:v]scale=-2:480[right];" +
      "[left][right]hstack=inputs=2[v];" +
      "[0:a][1:a]amix=inputs=2:duration=shortest[a]";
    const cmd = ["ffmpeg", "-y"];
    cmd.push(...inputArgs);
    cmd.push(
      "-filter_complex",
      filterComplex,
      "-map",
      "[v]",
      "-map",
      "[a]",
      "-c:v",
      codec,
      "-crf",
      String(crf),
      "-c:a",
      "aac",
      "-shortest",
      outputPath
    );
    await this.runCommand(cmd);
  }

  private async _spatialVerticalStack(
    clips: string[],
    outputPath: string,
    codec: string,
    crf: number
  ): Promise<void> {
    // Place clips in a vertical stack (top-bottom).
    const inputArgs = ["-i", clips[0]!, "-i", clips[1]!];
    const filterComplex =
      "[0:v]scale=540:-2[top];" +
      "[1:v]scale=540:-2[bottom];" +
      "[top][bottom]vstack=inputs=2[v];" +
      "[0:a][1:a]amix=inputs=2:duration=shortest[a]";
    const cmd = ["ffmpeg", "-y"];
    cmd.push(...inputArgs);
    cmd.push(
      "-filter_complex",
      filterComplex,
      "-map",
      "[v]",
      "-map",
      "[a]",
      "-c:v",
      codec,
      "-crf",
      String(crf),
      "-c:a",
      "aac",
      "-shortest",
      outputPath
    );
    await this.runCommand(cmd);
  }

  private async _spatialPip(
    clips: string[],
    outputPath: string,
    inputs: Record<string, any>,
    codec: string,
    crf: number
  ): Promise<void> {
    // Picture-in-picture: overlay second clip on first.
    const pipPosition = (inputs.pip_position as string) ?? "bottom_right";
    const pipScale = (inputs.pip_scale as number) ?? 0.3;
    const pipMargin = inputs.pip_margin ?? 10;

    // Build position expression based on corner
    const positionMap: Record<string, string> = {
      top_left: `${pipMargin}:${pipMargin}`,
      top_right: `main_w-overlay_w-${pipMargin}:${pipMargin}`,
      bottom_left: `${pipMargin}:main_h-overlay_h-${pipMargin}`,
      bottom_right: `main_w-overlay_w-${pipMargin}:main_h-overlay_h-${pipMargin}`,
    };
    const position = positionMap[pipPosition] ?? positionMap.bottom_right!;

    const inputArgs = ["-i", clips[0]!, "-i", clips[1]!];
    const filterComplex =
      `[1:v]scale=iw*${pipScale}:ih*${pipScale}[pip];` +
      `[0:v][pip]overlay=${position}:shortest=1[v]`;
    const cmd = ["ffmpeg", "-y"];
    cmd.push(...inputArgs);
    cmd.push(
      "-filter_complex",
      filterComplex,
      "-map",
      "[v]",
      "-map",
      "0:a?",
      "-c:v",
      codec,
      "-crf",
      String(crf),
      "-c:a",
      "aac",
      "-shortest",
      outputPath
    );
    await this.runCommand(cmd);
  }

  // ------------------------------------------------------------------
  // Cleanup
  // ------------------------------------------------------------------

  private static _cleanupTemp(tempDir: string, tempFiles: string[]): void {
    // Remove temporary files and directory.
    for (const f of tempFiles) {
      if (fs.existsSync(f)) {
        try {
          fs.unlinkSync(f);
        } catch {
          /* OSError — best effort */
        }
      }
    }
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmdirSync(tempDir);
      } catch {
        /* OSError — best effort */
      }
    }
  }
}
