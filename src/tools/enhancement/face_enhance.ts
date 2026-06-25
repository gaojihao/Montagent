/**
 * Face enhancement tool wrapping FFmpeg filters.
 *
 * TypeScript port of tools/enhancement/face_enhance.py. Applies skin smoothing,
 * sharpening, and lighting-correction presets to talking-head footage. All
 * presets are FFmpeg filter chains — no GPU or external models required.
 *
 * Parity notes vs. Python:
 *  - PRESETS (smartblur/unsharp/curves/colorbalance/hqdn3d strings), schema, and
 *    result data fields match verbatim.
 *  - _build_filter precedence matches: custom_vf (by key presence) > presets
 *    array (by key presence; unknown names skipped, chains joined by ",") >
 *    single named preset.
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
  vf: string;
}

// Named presets mapping to FFmpeg filter chains
export const PRESETS: Record<string, Preset> = {
  soft_skin: {
    description: "Gentle skin smoothing while preserving edges",
    vf: "smartblur=lr=1.0:ls=-0.5:lt=-3.0:cr=0.5:cs=-0.5:ct=-3.0",
  },
  sharpen: {
    description: "Edge sharpening for crisp detail",
    vf: "unsharp=5:5:1.0:5:5:0.0",
  },
  sharpen_light: {
    description: "Subtle sharpening for soft cameras",
    vf: "unsharp=3:3:0.5:3:3:0.0",
  },
  brighten: {
    description: "Lift shadows and midtones for poorly lit footage",
    vf: "curves=all='0/0 0.25/0.35 0.5/0.55 0.75/0.8 1/1'",
  },
  contrast_boost: {
    description: "Add punch with an S-curve contrast adjustment",
    vf: "curves=all='0/0 0.25/0.20 0.5/0.5 0.75/0.80 1/1'",
  },
  warm: {
    description: "Warm skin tones — slight orange shift",
    vf: "colorbalance=rs=0.05:gs=0.0:bs=-0.05:rm=0.05:gm=0.0:bm=-0.03",
  },
  cool: {
    description: "Cool tones — slight blue shift",
    vf: "colorbalance=rs=-0.03:gs=0.0:bs=0.05:rm=-0.02:gm=0.0:bm=0.03",
  },
  denoise: {
    description: "Temporal noise reduction for grainy footage",
    vf: "hqdn3d=4:3:6:4",
  },
  talking_head_standard: {
    description:
      "Combined preset: skin smoothing + sharpen edges + warm skin tones",
    vf:
      "smartblur=lr=1.0:ls=-0.5:lt=-3.0:cr=0.5:cs=-0.5:ct=-3.0," +
      "unsharp=5:5:0.6:5:5:0.0," +
      "colorbalance=rs=0.06:gs=0.01:bs=-0.04:rm=0.04:gm=0.01:bm=-0.03",
  },
};

/** Mirror Path.with_stem(f"{stem}_enhanced"): keep dir + ext, replace the stem. */
function withStemSuffix(p: string, append: string): string {
  const dir = path.dirname(p);
  const ext = path.extname(p);
  const stem = path.basename(p, ext);
  return path.join(dir, `${stem}${append}${ext}`);
}

export class FaceEnhance extends BaseTool {
  override name = "face_enhance";
  override version = "0.1.0";
  override tier = ToolTier.CORE;
  override capability = "enhancement";
  override provider = "ffmpeg";
  override stability = ToolStability.EXPERIMENTAL;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;

  override dependencies = ["cmd:ffmpeg"];
  override install_instructions =
    "Install FFmpeg: https://ffmpeg.org/download.html";
  override agent_skills = ["ffmpeg"];

  override capabilities = [
    "skin_smoothing",
    "sharpening",
    "lighting_correction",
    "color_balance",
    "denoise",
    "preset_chain",
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
        default: "talking_head_standard",
      },
      presets: {
        type: "array",
        items: { type: "string" },
        description: "Apply multiple presets in sequence",
      },
      custom_vf: {
        type: "string",
        description: "Custom FFmpeg video filter string (advanced)",
      },
      codec: { type: "string", default: "libx264" },
      crf: { type: "integer", default: 20 },
    },
  };

  override resource_profile: ResourceProfile = {
    cpu_cores: 2,
    ram_mb: 1024,
    vram_mb: 0,
    disk_mb: 2000,
    network_required: false,
  };
  override idempotency_key_fields = [
    "input_path",
    "preset",
    "presets",
    "custom_vf",
  ];
  override side_effects = ["writes enhanced video to output_path"];
  override user_visible_verification = [
    "Compare enhanced output with original side-by-side",
    "Verify skin texture is natural, not plastic",
  ];

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const inputPath = inputs.input_path as string;
    if (!fs.existsSync(inputPath)) {
      return toolResult({ success: false, error: `Input not found: ${inputPath}` });
    }

    const outputPath =
      (inputs.output_path as string) ?? withStemSuffix(inputPath, "_enhanced");
    const codec = (inputs.codec as string) ?? "libx264";
    const crf = (inputs.crf as number) ?? 20;

    // Build filter chain
    const vf = this._buildFilter(inputs);
    if (!vf) {
      return toolResult({
        success: false,
        error: "No preset, presets, or custom_vf specified",
      });
    }

    const start = Date.now();

    const cmd = [
      "ffmpeg",
      "-y",
      "-i",
      inputPath,
      "-vf",
      vf,
      "-c:v",
      codec,
      "-crf",
      String(crf),
      "-c:a",
      "copy",
      outputPath,
    ];

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
        filter: vf,
        preset: inputs.preset ?? null,
      },
      artifacts: [outputPath],
      duration_seconds: Math.round(elapsed * 100) / 100,
    });
  }

  private _buildFilter(inputs: Record<string, unknown>): string {
    if ("custom_vf" in inputs) {
      return inputs.custom_vf as string;
    }

    if ("presets" in inputs) {
      const chains: string[] = [];
      for (const name of inputs.presets as string[]) {
        const preset = PRESETS[name];
        if (!preset) {
          continue;
        }
        chains.push(preset.vf);
      }
      return chains.join(",");
    }

    const presetName = (inputs.preset as string) ?? "talking_head_standard";
    const preset = PRESETS[presetName];
    if (preset) {
      return preset.vf;
    }
    return "";
  }

  /** Return available presets and their descriptions. */
  static listPresets(): Record<string, string> {
    return Object.fromEntries(
      Object.entries(PRESETS).map(([name, p]) => [name, p.description])
    );
  }
}
