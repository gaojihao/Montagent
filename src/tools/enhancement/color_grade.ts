/**
 * Color grading tool wrapping FFmpeg LUT and filter chains.
 *
 * TypeScript port of tools/enhancement/color_grade.py. Applies cinematic color
 * grading profiles to video, supporting built-in profile presets and external
 * .cube LUT files.
 *
 * Parity notes vs. Python:
 *  - PROFILES (colorbalance/curves/eq strings), schema, and result data fields
 *    match verbatim.
 *  - _build_filter precedence matches: custom_vf (by key presence) > existing
 *    lut_path (lut3d with escaped path) > named profile, with the split/blend
 *    intensity blend applied for 0 < intensity < 1.
 *  - LUT path escaping (resolve + \\ -> / + : -> \:) matches verbatim.
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

interface Profile {
  description: string;
  vf: string;
}

// Built-in grading profiles using FFmpeg colorbalance/curves/eq filters
export const PROFILES: Record<string, Profile> = {
  cinematic_warm: {
    description:
      "Warm cinematic look with lifted shadows and orange highlights",
    vf:
      "colorbalance=rs=0.08:gs=0.02:bs=-0.05:rh=0.06:gh=0.02:bh=-0.04," +
      "curves=all='0/0.03 0.25/0.22 0.5/0.50 0.75/0.78 1/0.97'," +
      "eq=contrast=1.05:saturation=1.1",
  },
  cinematic_cool: {
    description: "Cool teal-and-orange cinematic grade",
    vf:
      "colorbalance=rs=-0.02:gs=-0.03:bs=0.08:rh=0.06:gh=-0.02:bh=-0.06," +
      "curves=all='0/0.02 0.25/0.20 0.5/0.48 0.75/0.78 1/0.98'," +
      "eq=contrast=1.08:saturation=1.05",
  },
  moody_dark: {
    description: "Crushed blacks, desaturated midtones, dark atmosphere",
    vf:
      "curves=all='0/0.05 0.15/0.12 0.5/0.45 0.85/0.82 1/0.95'," +
      "eq=contrast=1.12:saturation=0.8:brightness=-0.03",
  },
  bright_clean: {
    description: "Bright, clean look with lifted shadows and vivid color",
    vf:
      "curves=all='0/0.05 0.25/0.30 0.5/0.55 0.75/0.80 1/1.0'," +
      "eq=contrast=1.0:saturation=1.15:brightness=0.02",
  },
  vintage_film: {
    description: "Faded film look with grain texture and warm tint",
    vf:
      "colorbalance=rs=0.06:gs=0.03:bs=-0.03:ms=0.03:mh=-0.02," +
      "curves=all='0/0.06 0.25/0.25 0.5/0.50 0.75/0.74 1/0.94'," +
      "eq=saturation=0.85:contrast=0.95",
  },
  high_contrast: {
    description: "Punchy high-contrast grade for dynamic content",
    vf:
      "curves=all='0/0 0.20/0.12 0.5/0.50 0.80/0.88 1/1'," +
      "eq=contrast=1.2:saturation=1.1",
  },
  neutral: {
    description: "Minimal correction — normalize levels and light contrast",
    vf: "eq=contrast=1.02:saturation=1.02:brightness=0.01",
  },
};

/** Mirror Path.with_stem(f"{stem}_graded"): keep dir + ext, replace the stem. */
function withStemSuffix(p: string, append: string): string {
  const dir = path.dirname(p);
  const ext = path.extname(p);
  const stem = path.basename(p, ext);
  return path.join(dir, `${stem}${append}${ext}`);
}

export class ColorGrade extends BaseTool {
  override name = "color_grade";
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

  override capabilities = ["grade_preset", "grade_lut", "grade_custom"];

  override input_schema = {
    type: "object",
    required: ["input_path"],
    properties: {
      input_path: { type: "string" },
      output_path: { type: "string" },
      profile: {
        type: "string",
        enum: Object.keys(PROFILES),
        default: "cinematic_warm",
      },
      lut_path: {
        type: "string",
        description: "Path to external .cube LUT file",
      },
      intensity: {
        type: "number",
        minimum: 0.0,
        maximum: 1.0,
        default: 1.0,
        description: "Blend intensity: 0 = original, 1 = full grade",
      },
      custom_vf: { type: "string" },
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
    "profile",
    "lut_path",
    "intensity",
  ];
  override side_effects = ["writes graded video to output_path"];
  override user_visible_verification = [
    "Compare graded output with original for color accuracy",
    "Verify skin tones look natural, not oversaturated",
  ];

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const inputPath = inputs.input_path as string;
    if (!fs.existsSync(inputPath)) {
      return toolResult({ success: false, error: `Input not found: ${inputPath}` });
    }

    const outputPath =
      (inputs.output_path as string) ?? withStemSuffix(inputPath, "_graded");
    const codec = (inputs.codec as string) ?? "libx264";
    const crf = (inputs.crf as number) ?? 20;

    const vf = this._buildFilter(inputs);
    if (!vf) {
      return toolResult({
        success: false,
        error: "No profile, lut_path, or custom_vf specified",
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
        profile: inputs.profile ?? null,
        lut: inputs.lut_path ?? null,
        intensity: inputs.intensity ?? 1.0,
        filter: vf,
      },
      artifacts: [outputPath],
      duration_seconds: Math.round(elapsed * 100) / 100,
    });
  }

  private _buildFilter(inputs: Record<string, unknown>): string {
    if ("custom_vf" in inputs) {
      return inputs.custom_vf as string;
    }

    const lutPath = inputs.lut_path as string | undefined;
    if (lutPath && fs.existsSync(lutPath)) {
      const safePath = path
        .resolve(lutPath)
        .replace(/\\/g, "/")
        .replace(/:/g, "\\:");
      return `lut3d='${safePath}'`;
    }

    const profileName = (inputs.profile as string) ?? "cinematic_warm";
    const profile = PROFILES[profileName];
    if (!profile) {
      return "";
    }

    let vf = profile.vf;

    // Apply intensity blending if < 1.0
    const intensity = (inputs.intensity as number) ?? 1.0;
    if (intensity > 0 && intensity < 1.0) {
      // Use split + overlay approach: blend graded with original
      vf =
        `split[original][tograde];` +
        `[tograde]${vf}[graded];` +
        `[original][graded]blend=all_mode=normal:all_opacity=${intensity}`;
    }

    return vf;
  }

  /** Return available profiles and their descriptions. */
  static listProfiles(): Record<string, string> {
    return Object.fromEntries(
      Object.entries(PROFILES).map(([name, p]) => [name, p.description])
    );
  }
}
