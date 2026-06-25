/**
 * Audio enhancement tool for noise reduction and cleanup.
 *
 * TypeScript port of tools/audio/audio_enhance.py. Provides noise reduction,
 * normalization, and EQ via FFmpeg audio filters.
 *
 * Parity notes vs. Python:
 *  - The Python module mentioned optional pedalboard integration in its
 *    docstring, but the implementation is pure-FFmpeg (no pedalboard code path).
 *    The TS port reproduces that pure-FFmpeg behavior verbatim.
 *  - PRESETS, the `-af` filter strings, the video-vs-audio codec branching, and
 *    the result data fields all match the Python verbatim.
 *  - this.runCommand(["ffmpeg", ...]) is a 1:1 translation of self.run_command()
 *    (execa rejects on non-zero exit, matching subprocess check=True).
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

interface Preset {
  description: string;
  af: string;
}

export const PRESETS: Record<string, Preset> = {
  clean_speech: {
    description:
      "Noise gate + highpass + compressor + limiter for clean dialogue",
    af:
      "highpass=f=80," +
      "lowpass=f=13000," +
      "agate=threshold=0.01:ratio=2:attack=5:release=50," +
      "acompressor=threshold=-20dB:ratio=3:attack=5:release=100," +
      "loudnorm=I=-16:LRA=11:TP=-1.5",
  },
  noise_reduce: {
    description: "Aggressive noise reduction for noisy environments",
    af:
      "afftdn=nf=-25:nt=w," +
      "highpass=f=100," +
      "loudnorm=I=-16:LRA=11:TP=-1.5",
  },
  normalize_only: {
    description: "Loudness normalization without other processing",
    af: "loudnorm=I=-16:LRA=11:TP=-1.5",
  },
  podcast: {
    description: "Podcast-style processing: de-ess, compress, normalize",
    af:
      "highpass=f=80," +
      "acompressor=threshold=-18dB:ratio=4:attack=5:release=100:makeup=2," +
      "loudnorm=I=-16:LRA=7:TP=-1.5",
  },
  broadcast: {
    description: "Broadcast-standard processing with tight dynamics",
    af:
      "highpass=f=80," +
      "lowpass=f=15000," +
      "acompressor=threshold=-24dB:ratio=4:attack=5:release=80:makeup=3," +
      "alimiter=limit=0.95:attack=1:release=10," +
      "loudnorm=I=-24:LRA=7:TP=-2",
  },
  voice_clarity: {
    description: "Boost vocal presence with EQ and light compression",
    af:
      "highpass=f=80," +
      "equalizer=f=200:t=q:w=1.5:g=-3," +
      "equalizer=f=3000:t=q:w=1.0:g=3," +
      "equalizer=f=5000:t=q:w=1.5:g=2," +
      "acompressor=threshold=-20dB:ratio=2.5:attack=10:release=100," +
      "loudnorm=I=-16:LRA=11:TP=-1.5",
  },
};

const VIDEO_SUFFIXES = new Set([".mp4", ".mkv", ".avi", ".mov", ".webm"]);

/** Mirror Path.with_stem(f"{stem}_enhanced"): keep dir + ext, replace the stem. */
function withStemSuffix(p: string, append: string): string {
  const dir = path.dirname(p);
  const ext = path.extname(p);
  const stem = path.basename(p, ext);
  return path.join(dir, `${stem}${append}${ext}`);
}

export class AudioEnhance extends BaseTool {
  override name = "audio_enhance";
  override version = "0.1.0";
  override tier = ToolTier.CORE;
  override capability = "audio_processing";
  override provider = "ffmpeg";
  override stability = ToolStability.EXPERIMENTAL;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;

  override dependencies = ["cmd:ffmpeg"];
  override install_instructions =
    "Install FFmpeg: https://ffmpeg.org/download.html";
  override agent_skills = ["ffmpeg", "elevenlabs"];

  override capabilities = [
    "noise_reduction",
    "normalization",
    "compression",
    "eq",
    "speech_cleanup",
  ];

  override input_schema = {
    type: "object",
    required: ["input_path"],
    properties: {
      input_path: { type: "string" },
      output_path: { type: "string" },
      preset: {
        type: "string",
        enum: Object.keys(PRESETS),
        default: "clean_speech",
      },
      custom_af: {
        type: "string",
        description: "Custom FFmpeg audio filter string",
      },
      audio_codec: { type: "string", default: "aac" },
      audio_bitrate: { type: "string", default: "192k" },
    },
  };

  override resource_profile: ResourceProfile = {
    cpu_cores: 1,
    ram_mb: 512,
    vram_mb: 0,
    disk_mb: 500,
    network_required: false,
  };
  override idempotency_key_fields = ["input_path", "preset", "custom_af"];
  override side_effects = ["writes enhanced audio/video to output_path"];
  override user_visible_verification = [
    "Listen to enhanced audio and compare with original",
    "Verify speech is clear without artifacts or pumping",
  ];

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const inputPath = inputs.input_path as string;
    if (!fs.existsSync(inputPath)) {
      return toolResult({ success: false, error: `Input not found: ${inputPath}` });
    }

    const outputPath =
      (inputs.output_path as string) ?? withStemSuffix(inputPath, "_enhanced");
    const audioCodec = (inputs.audio_codec as string) ?? "aac";
    const audioBitrate = (inputs.audio_bitrate as string) ?? "192k";

    let af = inputs.custom_af as string | undefined;
    if (!af) {
      const presetName = (inputs.preset as string) ?? "clean_speech";
      const preset = PRESETS[presetName];
      if (!preset) {
        return toolResult({ success: false, error: `Unknown preset: ${presetName}` });
      }
      af = preset.af;
    }

    const start = Date.now();

    // Determine if input is video or audio-only
    const isVideo = VIDEO_SUFFIXES.has(path.extname(inputPath).toLowerCase());

    const cmd = ["ffmpeg", "-y", "-i", inputPath, "-af", af];
    if (isVideo) {
      cmd.push("-c:v", "copy");
    }
    cmd.push("-c:a", audioCodec, "-b:a", audioBitrate);
    cmd.push(outputPath);

    try {
      await this.runCommand(cmd);
    } catch (e) {
      return toolResult({
        success: false,
        error: `FFmpeg failed: ${(e as Error).message ?? e}`,
      });
    }

    const elapsed = (Date.now() - start) / 1000;

    return toolResult({
      success: true,
      data: {
        input: inputPath,
        output: outputPath,
        preset: inputs.preset ?? null,
        filter: af,
      },
      artifacts: [outputPath],
      duration_seconds: Math.round(elapsed * 100) / 100,
    });
  }

  /** Return available presets and their descriptions. */
  static listPresets(): Record<string, string> {
    return Object.fromEntries(
      Object.entries(PRESETS).map(([name, p]) => [name, p.description])
    );
  }
}
