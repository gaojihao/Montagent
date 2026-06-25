/**
 * Audio mixer tool wrapping FFmpeg.
 *
 * TypeScript port of tools/audio/audio_mixer.py. Mixes speech, music, and SFX
 * tracks with support for ducking, fades, and volume normalization.
 *
 * Parity notes vs. Python:
 *  - The Python docstring mentioned an optional pydub path, but the
 *    implementation is pure-FFmpeg; the TS port reproduces the FFmpeg-only
 *    behavior verbatim.
 *  - Every FFmpeg filter_complex string, the operation dispatch, the
 *    simple/advanced ducking input formats, the sidechaincompress params, the
 *    segmented-music volume expression, and the result data fields all match
 *    the Python verbatim (including the somewhat convoluted _full_mix graph
 *    construction with its empty-filter-part handling).
 *  - `(await this.runCommand(...)).stdout` mirrors run_command(...).stdout used
 *    by _segmented_music to read the ffprobe duration.
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

interface Track {
  path: string;
  role?: string;
  volume?: number;
  start_seconds?: number;
  fade_in_seconds?: number;
  fade_out_seconds?: number;
}

interface Ducking {
  enabled?: boolean;
  music_volume_during_speech?: number;
  attack_ms?: number;
  release_ms?: number;
}

interface Segment {
  start: number;
  end: number;
}

export class AudioMixer extends BaseTool {
  override name = "audio_mixer";
  override version = "0.1.0";
  override tier = ToolTier.CORE;
  override capability = "audio_processing";
  override provider = "ffmpeg";
  override stability = ToolStability.EXPERIMENTAL;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;

  override dependencies = ["cmd:ffmpeg"];
  override install_instructions =
    "FFmpeg is required. pydub is optional for advanced mixing:\n" +
    "pip install pydub";
  override agent_skills = ["ffmpeg", "video_toolkit"];

  override capabilities = [
    "mix",
    "duck",
    "fade",
    "normalize",
    "extract_audio",
    "segmented_music",
  ];

  override input_schema = {
    type: "object",
    required: ["operation"],
    properties: {
      operation: {
        type: "string",
        enum: ["mix", "duck", "extract", "full_mix", "segmented_music"],
        description:
          "mix: layer multiple tracks with volume/delay/fades. " +
          "duck: lower music volume when speech is present. " +
          "extract: extract audio from video file. " +
          "full_mix: combine narration tracks + music with ducking + normalize " +
          "in a single call (preferred for compose-director). " +
          "segmented_music: mix music into a video only during specified " +
          "time segments (e.g. music during talking head, silence during " +
          "showcase clips).",
      },
      tracks: {
        type: "array",
        description:
          "Audio tracks for mix/duck operations (advanced format). " +
          "For duck, each track needs a 'role' of 'speech' or 'music'. " +
          "For the simple duck API, use primary_audio/secondary_audio instead.",
        items: {
          type: "object",
          required: ["path", "role"],
          properties: {
            path: { type: "string" },
            role: {
              type: "string",
              enum: ["speech", "music", "sfx", "primary", "secondary"],
            },
            volume: { type: "number", minimum: 0, maximum: 1.0, default: 1.0 },
            start_seconds: { type: "number", minimum: 0 },
            fade_in_seconds: { type: "number", minimum: 0 },
            fade_out_seconds: { type: "number", minimum: 0 },
          },
        },
      },
      primary_audio: {
        type: "string",
        description:
          "Path to primary/speech audio track (duck operation, simple format). " +
          "This is the track that stays at full volume (e.g. narration/dialogue). " +
          "Use with secondary_audio as an alternative to the tracks array.",
      },
      secondary_audio: {
        type: "string",
        description:
          "Path to secondary/music audio track (duck operation, simple format). " +
          "This track gets ducked (volume lowered) when primary audio is present. " +
          "Use with primary_audio as an alternative to the tracks array.",
      },
      duck_level: {
        type: "number",
        description:
          "Ducking attenuation in dB for the secondary track (duck operation, " +
          "simple format). Negative values reduce volume, e.g. -12 means duck " +
          "by 12dB. Converted to a linear ratio internally. Default: -12.",
        default: -12,
      },
      input_path: { type: "string", description: "Input for extract operation" },
      output_path: { type: "string" },
      ducking: {
        type: "object",
        description:
          "Advanced ducking parameters. Works with both the simple " +
          "(primary_audio/secondary_audio) and advanced (tracks) formats.",
        properties: {
          enabled: { type: "boolean", default: true },
          music_volume_during_speech: {
            type: "number",
            minimum: 0,
            maximum: 1.0,
            default: 0.15,
          },
          attack_ms: { type: "number", default: 200 },
          release_ms: { type: "number", default: 500 },
        },
      },
      normalize: { type: "boolean", default: true },
      video_path: {
        type: "string",
        description:
          "Path to the assembled video (segmented_music operation). " +
          "Music is mixed into this video's audio at specified segments.",
      },
      music_path: {
        type: "string",
        description: "Path to background music file (segmented_music operation).",
      },
      music_volume: {
        type: "number",
        minimum: 0,
        maximum: 1.0,
        default: 0.2,
        description: "Volume level for music during active segments.",
      },
      segments: {
        type: "array",
        description:
          "Time segments where music should play (segmented_music operation). " +
          "Each segment: {start: seconds, end: seconds}. Music fades in/out " +
          "at segment boundaries. Outside these segments, music is silent.",
        items: {
          type: "object",
          required: ["start", "end"],
          properties: {
            start: { type: "number", minimum: 0 },
            end: { type: "number", minimum: 0 },
          },
        },
      },
      fade_duration: {
        type: "number",
        default: 0.5,
        description: "Duration of fade in/out at segment boundaries (seconds).",
      },
    },
  };

  override resource_profile: ResourceProfile = {
    cpu_cores: 2,
    ram_mb: 1024,
    vram_mb: 0,
    disk_mb: 500,
    network_required: false,
  };
  override idempotency_key_fields = ["operation", "tracks", "ducking"];
  override side_effects = ["writes mixed audio file to output_path"];
  override user_visible_verification = [
    "Listen to mixed output and verify speech clarity and music ducking",
  ];

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const operation = inputs.operation as string;
    const start = Date.now();

    let result: ToolResult;
    try {
      if (operation === "mix") {
        result = await this._mix(inputs);
      } else if (operation === "duck") {
        result = await this._duck(inputs);
      } else if (operation === "extract") {
        result = await this._extract(inputs);
      } else if (operation === "full_mix") {
        result = await this._fullMix(inputs);
      } else if (operation === "segmented_music") {
        result = await this._segmentedMusic(inputs);
      } else {
        return toolResult({ success: false, error: `Unknown operation: ${operation}` });
      }
    } catch (e) {
      return toolResult({ success: false, error: `${(e as Error).message ?? e}` });
    }

    result.duration_seconds = Math.round(((Date.now() - start) / 1000) * 100) / 100;
    return result;
  }

  /** Mix multiple audio tracks into one output. */
  private async _mix(inputs: Record<string, unknown>): Promise<ToolResult> {
    const tracks = (inputs.tracks as Track[]) ?? [];
    if (!tracks.length) {
      return toolResult({ success: false, error: "No tracks provided" });
    }

    const outputPath = (inputs.output_path as string) ?? "mixed_audio.wav";
    const normalize = (inputs.normalize as boolean) ?? true;

    // Validate all inputs exist
    for (const t of tracks) {
      if (!fs.existsSync(t.path)) {
        return toolResult({ success: false, error: `Track not found: ${t.path}` });
      }
    }

    // Build FFmpeg complex filter for mixing
    const filterParts: string[] = [];
    const inputArgs: string[] = [];

    tracks.forEach((track, i) => {
      inputArgs.push("-i", track.path);
      const volume = track.volume ?? 1.0;
      const delayMs = Math.trunc((track.start_seconds ?? 0) * 1000);
      const fadeIn = track.fade_in_seconds ?? 0;
      const fadeOut = track.fade_out_seconds ?? 0;

      const filters: string[] = [];
      if (volume !== 1.0) filters.push(`volume=${volume}`);
      if (delayMs > 0) filters.push(`adelay=${delayMs}|${delayMs}`);
      if (fadeIn > 0) filters.push(`afade=t=in:d=${fadeIn}`);
      if (fadeOut > 0) filters.push(`afade=t=out:d=${fadeOut}`);

      if (filters.length) {
        const filterChain = filters.join(",");
        filterParts.push(`[${i}:a]${filterChain}[a${i}]`);
      } else {
        filterParts.push(`[${i}:a]acopy[a${i}]`);
      }
    });

    // Amix all processed streams
    const mixInputs = tracks.map((_, i) => `[a${i}]`).join("");
    filterParts.push(
      `${mixInputs}amix=inputs=${tracks.length}:duration=longest:dropout_transition=2[mixed]`
    );

    let outLabel: string;
    if (normalize) {
      filterParts.push("[mixed]loudnorm=I=-16:LRA=11:TP=-1.5[out]");
      outLabel = "[out]";
    } else {
      outLabel = "[mixed]";
    }

    const filterComplex = filterParts.join(";");

    const cmd = ["ffmpeg", "-y"];
    cmd.push(...inputArgs);
    cmd.push("-filter_complex", filterComplex);
    cmd.push("-map", outLabel, outputPath);

    await this.runCommand(cmd);

    return toolResult({
      success: true,
      data: {
        operation: "mix",
        track_count: tracks.length,
        output: outputPath,
        normalized: normalize,
      },
      artifacts: [outputPath],
    });
  }

  /**
   * Apply ducking: lower music volume when speech is present.
   *
   * Accepts two input formats (simple primary_audio/secondary_audio, or an
   * advanced tracks array with role fields).
   */
  private async _duck(inputs: Record<string, unknown>): Promise<ToolResult> {
    let ducking: Ducking = (inputs.ducking as Ducking) ?? {};
    const outputPath = (inputs.output_path as string) ?? "ducked_audio.wav";

    // --- Resolve speech/music paths from either input format ---
    let speechPath: string | undefined;
    let musicPath: string | undefined;

    // Simple format: primary_audio / secondary_audio
    if ("primary_audio" in inputs || "secondary_audio" in inputs) {
      speechPath = inputs.primary_audio as string | undefined;
      musicPath = inputs.secondary_audio as string | undefined;
      // If duck_level (dB) is provided, convert to linear ratio for
      // music_volume_during_speech.  e.g. -12 dB -> 10^(-12/20) ~ 0.25
      if ("duck_level" in inputs && !("ducking" in inputs)) {
        const db = inputs.duck_level as number;
        ducking = { ...ducking }; // copy so we don't mutate caller
        if (ducking.music_volume_during_speech === undefined) {
          ducking.music_volume_during_speech =
            Math.round(Math.pow(10, db / 20) * 10000) / 10000;
        }
      }
    }

    // Advanced format: tracks array with role field
    const tracks = (inputs.tracks as Track[]) ?? [];
    if (tracks.length && speechPath === undefined && musicPath === undefined) {
      // Support both naming conventions: speech/music and primary/secondary
      const speechTracks = tracks.filter(
        (t) => t.role === "speech" || t.role === "primary"
      );
      const musicTracks = tracks.filter(
        (t) => t.role === "music" || t.role === "secondary"
      );
      if (speechTracks.length) speechPath = speechTracks[0]!.path;
      if (musicTracks.length) musicPath = musicTracks[0]!.path;
    }

    if (!speechPath || !musicPath) {
      return toolResult({
        success: false,
        error:
          "Ducking requires a primary (speech) and secondary (music) track. " +
          "Provide either primary_audio/secondary_audio params, or a tracks " +
          "array with role='speech'/'primary' and role='music'/'secondary'.",
      });
    }

    // Use FFmpeg sidechaincompress for ducking
    const musicVol = ducking.music_volume_during_speech ?? 0.15;
    const attack = (ducking.attack_ms ?? 200) / 1000;
    const release = (ducking.release_ms ?? 500) / 1000;

    // Sidechain compress: use speech as the key signal to duck music
    const filterComplex =
      `[1:a]sidechaincompress=` +
      `threshold=0.02:ratio=9:attack=${attack}:release=${release}:` +
      `level_sc=1:mix=0.9[ducked];` +
      `[ducked]volume=${musicVol * 3}[music_out];` + // compensate sidechain level
      `[0:a][music_out]amix=inputs=2:duration=longest[out]`;

    const cmd = [
      "ffmpeg",
      "-y",
      "-i",
      speechPath,
      "-i",
      musicPath,
      "-filter_complex",
      filterComplex,
      "-map",
      "[out]",
      outputPath,
    ];

    await this.runCommand(cmd);

    return toolResult({
      success: true,
      data: {
        operation: "duck",
        speech_track: speechPath,
        music_track: musicPath,
        output: outputPath,
      },
      artifacts: [outputPath],
    });
  }

  /** Extract audio from a video file. */
  private async _extract(inputs: Record<string, unknown>): Promise<ToolResult> {
    const inputPath = inputs.input_path as string;
    if (!fs.existsSync(inputPath)) {
      return toolResult({ success: false, error: `Input not found: ${inputPath}` });
    }

    const outputPath =
      (inputs.output_path as string) ?? withSuffix(inputPath, ".wav");

    const cmd = [
      "ffmpeg",
      "-y",
      "-i",
      inputPath,
      "-vn",
      "-acodec",
      "pcm_s16le",
      "-ar",
      "16000",
      "-ac",
      "1",
      outputPath,
    ];

    await this.runCommand(cmd);

    return toolResult({
      success: true,
      data: {
        operation: "extract",
        input: inputPath,
        output: outputPath,
      },
      artifacts: [outputPath],
    });
  }

  /**
   * One-call mix: layer narration tracks, add music with ducking, normalize.
   *
   * Preferred operation for the compose-director skill. Combines mix + duck +
   * normalize in a single FFmpeg filter graph.
   */
  private async _fullMix(inputs: Record<string, unknown>): Promise<ToolResult> {
    const tracks = (inputs.tracks as Track[]) ?? [];
    if (!tracks.length) {
      return toolResult({ success: false, error: "No tracks provided for full_mix" });
    }

    const outputPath = (inputs.output_path as string) ?? "full_mix_output.wav";
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    const normalize = (inputs.normalize as boolean) ?? true;
    const ducking = (inputs.ducking as Ducking | boolean) ?? { enabled: true };

    const speechTracks = tracks.filter(
      (t) => t.role === "speech" || t.role === "primary"
    );
    const musicTracks = tracks.filter(
      (t) => t.role === "music" || t.role === "secondary"
    );
    const sfxTracks = tracks.filter((t) => t.role === "sfx");
    const allTracks = [...speechTracks, ...musicTracks, ...sfxTracks];

    if (!allTracks.length) {
      return toolResult({
        success: false,
        error: "No valid tracks (need speech/music/sfx roles)",
      });
    }

    // Validate all files exist
    for (const t of allTracks) {
      if (!fs.existsSync(t.path)) {
        return toolResult({ success: false, error: `Track not found: ${t.path}` });
      }
    }

    // Build FFmpeg inputs and filter graph
    const inputArgs: string[] = [];
    const filterParts: string[] = [];

    allTracks.forEach((track, i) => {
      inputArgs.push("-i", track.path);
      const volume = track.volume ?? 1.0;
      const delayMs = Math.trunc((track.start_seconds ?? 0) * 1000);
      const fadeIn = track.fade_in_seconds ?? 0;
      const fadeOut = track.fade_out_seconds ?? 0;

      const filters: string[] = [];
      if (volume !== 1.0) filters.push(`volume=${volume}`);
      if (delayMs > 0) filters.push(`adelay=${delayMs}|${delayMs}`);
      if (fadeIn > 0) filters.push(`afade=t=in:d=${fadeIn}`);
      if (fadeOut > 0) filters.push(`afade=t=out:d=${fadeOut}`);

      if (filters.length) {
        const filterChain = filters.join(",");
        filterParts.push(`[${i}:a]${filterChain}[a${i}]`);
      } else {
        filterParts.push(`[${i}:a]acopy[a${i}]`);
      }
    });

    // If ducking is enabled and we have both speech and music, apply sidechain
    const isDuckObj =
      typeof ducking === "object" && ducking !== null;
    const duckEnabled = isDuckObj
      ? (ducking as Ducking).enabled ?? true
      : Boolean(ducking);

    if (duckEnabled && speechTracks.length && musicTracks.length) {
      // Mix speech tracks together first
      const speechIndices = Array.from(
        { length: speechTracks.length },
        (_, i) => i
      );
      const speechLabels = speechIndices.map((i) => `[a${i}]`).join("");

      let speechOut: string;
      if (speechTracks.length > 1) {
        filterParts.push(
          `${speechLabels}amix=inputs=${speechTracks.length}:duration=longest[speech_mix]`
        );
        speechOut = "[speech_mix]";
      } else {
        speechOut = `[a${speechIndices[0]}]`;
      }

      // Mix music tracks together
      const musicStart = speechTracks.length;
      const musicIndices = Array.from(
        { length: musicTracks.length },
        (_, i) => musicStart + i
      );
      const musicLabels = musicIndices.map((i) => `[a${i}]`).join("");

      let musicIn: string;
      if (musicTracks.length > 1) {
        filterParts.push(
          `${musicLabels}amix=inputs=${musicTracks.length}:duration=longest[music_mix]`
        );
        musicIn = "[music_mix]";
      } else {
        musicIn = `[a${musicIndices[0]}]`;
      }

      // Apply sidechain ducking
      const duckParams: Ducking = isDuckObj ? (ducking as Ducking) : {};
      const attack = (duckParams.attack_ms ?? 200) / 1000;
      const release = (duckParams.release_ms ?? 500) / 1000;
      const musicVol = duckParams.music_volume_during_speech ?? 0.15;

      filterParts.push(
        `${musicIn}${speechOut}sidechaincompress=` +
          `threshold=0.02:ratio=9:attack=${attack}:release=${release}:` +
          `level_sc=1:mix=0.9[ducked_music];` +
          `[ducked_music]volume=${musicVol * 3}[music_out]`
      );

      // Duplicate speech for final mix (sidechain consumes it as key)
      filterParts.push(
        speechOut.startsWith("[a") ? `${speechOut}acopy[speech_dup]` : ""
      );
      // Re-mix speech path: we need speech audio in the output too.
      // (Mirrors the Python: the sidechain uses speech as the key signal but
      // doesn't consume it from the output chain, so we rebuild a speech mix.)
      // Remove the last filter_part (the acopy that may be empty)
      if (filterParts.length && filterParts[filterParts.length - 1] === "") {
        filterParts.pop();
      }

      // Build speech mix for output separately
      if (speechTracks.length > 1) {
        // speech_mix already exists, make a copy for output
        filterParts.push(
          `${speechLabels}amix=inputs=${speechTracks.length}:duration=longest[speech_out]`
        );
      } else {
        filterParts.push(`[a${speechIndices[0]}]acopy[speech_out]`);
      }

      // Final mix: speech_out + music_out
      const mixLabel =
        "[speech_out][music_out]amix=inputs=2:duration=longest[premix]";

      // Add SFX if present
      const sfxStart = speechTracks.length + musicTracks.length;
      if (sfxTracks.length) {
        const sfxLabels = Array.from(
          { length: sfxTracks.length },
          (_, i) => `[a${sfxStart + i}]`
        ).join("");
        filterParts.push(mixLabel.replace("[premix]", "[pressfx]"));
        filterParts.push(
          `[pressfx]${sfxLabels}amix=inputs=${1 + sfxTracks.length}:duration=longest[premix]`
        );
      } else {
        filterParts.push(mixLabel);
      }
    } else {
      // No ducking: simple amix of all tracks
      const allLabels = allTracks.map((_, i) => `[a${i}]`).join("");
      filterParts.push(
        `${allLabels}amix=inputs=${allTracks.length}:duration=longest:dropout_transition=2[premix]`
      );
    }

    // Normalize
    let outLabel: string;
    if (normalize) {
      filterParts.push("[premix]loudnorm=I=-16:LRA=11:TP=-1.5[out]");
      outLabel = "[out]";
    } else {
      outLabel = "[premix]";
    }

    const filterComplex = filterParts.filter((p) => p).join(";");

    const cmd = ["ffmpeg", "-y"];
    cmd.push(...inputArgs);
    cmd.push("-filter_complex", filterComplex);
    cmd.push("-map", outLabel, outputPath);

    await this.runCommand(cmd);

    return toolResult({
      success: true,
      data: {
        operation: "full_mix",
        speech_tracks: speechTracks.length,
        music_tracks: musicTracks.length,
        sfx_tracks: sfxTracks.length,
        ducking_enabled: duckEnabled,
        normalized: normalize,
        output: outputPath,
      },
      artifacts: [outputPath],
    });
  }

  /**
   * Mix background music into a video only during specified time segments.
   *
   * Uses FFmpeg volume expressions with smooth fades at segment boundaries.
   * Music is silent outside the specified segments.
   */
  private async _segmentedMusic(
    inputs: Record<string, unknown>
  ): Promise<ToolResult> {
    const videoPath = inputs.video_path as string | undefined;
    const musicPath = inputs.music_path as string | undefined;
    const outputPath =
      (inputs.output_path as string) ?? "segmented_music_output.mp4";
    const segments = (inputs.segments as Segment[]) ?? [];
    const musicVolume = (inputs.music_volume as number) ?? 0.2;
    const fadeDur = (inputs.fade_duration as number) ?? 0.5;

    if (!videoPath || !fs.existsSync(videoPath)) {
      return toolResult({ success: false, error: `Video not found: ${videoPath}` });
    }
    if (!musicPath || !fs.existsSync(musicPath)) {
      return toolResult({ success: false, error: `Music not found: ${musicPath}` });
    }
    if (!segments.length) {
      return toolResult({ success: false, error: "No segments specified" });
    }

    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });

    // Get video duration
    const durCmd = [
      "ffprobe",
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      videoPath,
    ];
    const durResult = await this.runCommand(durCmd);
    const totalDur = parseFloat(
      String(durResult.stdout).trim().split("\n")[0] ?? ""
    );

    // Build volume expression for each segment with smooth fades
    const parts: string[] = [];
    const sortedSegments = [...segments].sort((a, b) => a.start - b.start);
    for (const seg of sortedSegments) {
      const s = seg.start;
      const e = seg.end;
      const fadeInEnd = s + fadeDur;
      const fadeOutStart = e - fadeDur;
      parts.push(
        `if(lt(t,${s}),0,` +
          `if(lt(t,${fadeInEnd}),${musicVolume}*(t-${s})/${fadeDur},` +
          `if(lt(t,${fadeOutStart}),${musicVolume},` +
          `if(lt(t,${e}),${musicVolume}*(${e}-t)/${fadeDur},` +
          `0))))`
      );
    }

    const volExpr =
      parts.length > 1 ? parts.map((p) => `(${p})`).join("+") : parts[0];

    const filterComplex =
      `[1:a]atrim=0:${totalDur},asetpts=PTS-STARTPTS,` +
      `volume='${volExpr}':eval=frame[music_shaped];` +
      `[0:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[speech];` +
      `[music_shaped]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[music_fmt];` +
      `[speech][music_fmt]amix=inputs=2:duration=first:dropout_transition=2[aout]`;

    const cmd = [
      "ffmpeg",
      "-y",
      "-i",
      videoPath,
      "-stream_loop",
      "-1",
      "-i",
      musicPath,
      "-filter_complex",
      filterComplex,
      "-map",
      "0:v",
      "-map",
      "[aout]",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      outputPath,
    ];

    await this.runCommand(cmd);

    if (!fs.existsSync(outputPath)) {
      return toolResult({ success: false, error: "No output produced" });
    }

    return toolResult({
      success: true,
      data: {
        operation: "segmented_music",
        video: videoPath,
        music: musicPath,
        segments,
        music_volume: musicVolume,
        fade_duration: fadeDur,
        output: outputPath,
      },
      artifacts: [outputPath],
    });
  }
}

/** Mirror Path.with_suffix(ext): replace the file's extension. */
function withSuffix(p: string, ext: string): string {
  const dir = path.dirname(p);
  const base = path.basename(p, path.extname(p));
  return path.join(dir, `${base}${ext}`);
}
