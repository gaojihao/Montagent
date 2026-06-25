/**
 * Pre-render composition validator.
 *
 * TypeScript port of tools/analysis/composition_validator.py. Checks a
 * composition JSON for common issues before rendering:
 *  - Missing asset files (images, audio)
 *  - Narration duration exceeding video duration
 *  - Music duration shorter than video (warning)
 *  - Overlapping or out-of-order cuts
 *  - Required fields present
 *
 * Run this before every render to catch problems that would otherwise produce
 * broken or truncated output.
 *
 * Parity notes vs. Python:
 *  - Pure-logic port: every validation rule, the assets-root resolution
 *    (explicit > runtime dispatch: remotion/hyperframes/ffmpeg, with the
 *    5-level parent walk), the error/warning/info messages, and the result
 *    shape are translated faithfully. The validation rules matter.
 *  - Python declared dependencies=["binary:ffprobe"] but overrode get_status()
 *    to always return AVAILABLE (the tool degrades gracefully when ffprobe is
 *    missing — probe_duration just returns None). The TS port keeps that exact
 *    behavior by overriding getStatus() to AVAILABLE and leaving dependencies
 *    empty so the contract never reports UNAVAILABLE.
 *  - probe_duration is provided by audio_probe.ts (async here); execute() awaits
 *    it for narration/music duration checks, matching the Python flow.
 *  - Numeric formatting matches Python f-strings: `:.1f` -> toFixed(1); bare
 *    numbers (video_duration, overshoot in some branches) print like Python's
 *    default str() (integers without a trailing .0).
 */
import fs from "node:fs";
import path from "node:path";
import {
  BaseTool,
  Determinism,
  ExecutionMode,
  ResourceProfile,
  ToolResult,
  ToolRuntime,
  ToolStability,
  ToolStatus,
  ToolTier,
  toolResult,
} from "../base_tool.js";
import { probeDuration } from "./audio_probe.js";

export class CompositionValidator extends BaseTool {
  override name = "composition_validator";
  override version = "0.1.0";
  override tier = ToolTier.CORE;
  override capability = "analysis";
  override provider = "local";
  override stability = ToolStability.PRODUCTION;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;
  override runtime = ToolRuntime.LOCAL;

  // Python listed dependencies=["binary:ffprobe"] but always reported AVAILABLE
  // (it degrades gracefully without ffprobe). We mirror that: no hard deps, and
  // getStatus() is overridden to AVAILABLE below.
  override dependencies = [];
  override install_instructions = "Requires ffprobe on PATH (part of ffmpeg).";

  override capabilities = ["validate_composition", "pre_render_check"];
  override best_for = [
    "catching audio-video duration mismatches before render",
    "verifying all referenced assets exist",
    "pre-flight check before expensive render operations",
  ];

  override input_schema = {
    type: "object",
    required: ["composition_path"],
    properties: {
      composition_path: {
        type: "string",
        description: "Path to the composition JSON file",
      },
      assets_root: {
        type: "string",
        description:
          "Root directory for resolving relative asset paths. " +
          "If omitted, resolved from render_runtime (see below).",
      },
      render_runtime: {
        type: "string",
        enum: ["remotion", "hyperframes", "ffmpeg"],
        description:
          "Which runtime will consume this composition. Drives the " +
          "default asset root: remotion→remotion-composer/public, " +
          "hyperframes→<workspace>/assets or composition's parent, " +
          "ffmpeg→composition's parent. Explicit assets_root wins.",
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
  override side_effects = [];

  override getStatus(): ToolStatus {
    return ToolStatus.AVAILABLE;
  }

  override estimateCost(_inputs: Record<string, unknown>): number {
    return 0.0;
  }

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const compPath = inputs.composition_path as string;
    if (!fs.existsSync(compPath)) {
      return toolResult({ success: false, error: `Composition not found: ${compPath}` });
    }

    const start = Date.now();

    let comp: Record<string, unknown>;
    try {
      comp = JSON.parse(fs.readFileSync(compPath, { encoding: "utf-8" }));
    } catch (e) {
      return toolResult({ success: false, error: `Invalid JSON: ${(e as Error).message}` });
    }

    // Determine assets root. Explicit wins; otherwise dispatch by runtime.
    // `render_runtime` may be passed in inputs, or extracted from the
    // composition JSON itself (edit_decisions.render_runtime).
    const explicitRoot = (inputs.assets_root as string) || "";
    let assetsRoot: string | null = explicitRoot ? explicitRoot : null;
    const runtime = String(
      (inputs.render_runtime as string) || (comp.render_runtime as string) || ""
    )
      .trim()
      .toLowerCase();

    if (assetsRoot === null || !isDir(assetsRoot)) {
      if (runtime === "hyperframes") {
        // HyperFrames workspaces keep assets/ alongside index.html.
        // Composition JSON typically lives in projects/<p>/artifacts/,
        // so the workspace is at projects/<p>/hyperframes/.
        let candidate = compPath;
        let resolved: string | null = null;
        for (let i = 0; i < 5; i++) {
          candidate = path.dirname(candidate);
          const hfAssets = path.join(candidate, "hyperframes", "assets");
          if (isDir(hfAssets)) {
            resolved = hfAssets;
            break;
          }
          const localAssets = path.join(candidate, "assets");
          if (isDir(localAssets) && isFile(path.join(candidate, "index.html"))) {
            resolved = localAssets;
            break;
          }
        }
        assetsRoot = resolved ?? path.dirname(compPath);
      } else if (runtime === "ffmpeg") {
        // FFmpeg jobs reference files by absolute path; fall back to
        // the composition's parent for any bare-name references.
        assetsRoot = path.dirname(compPath);
      } else {
        // Remotion (default): remotion-composer/public
        let candidate = compPath;
        let resolved: string | null = null;
        for (let i = 0; i < 5; i++) {
          candidate = path.dirname(candidate);
          const pub = path.join(candidate, "remotion-composer", "public");
          if (isDir(pub)) {
            resolved = pub;
            break;
          }
        }
        assetsRoot = resolved ?? path.dirname(compPath);
      }
    }

    const errors: string[] = [];
    const warnings: string[] = [];
    const info: string[] = [];

    const cuts = (comp.cuts as Array<Record<string, unknown>>) ?? [];
    const audio = (comp.audio as Record<string, unknown>) ?? {};

    // --- Check 1: Cuts exist ---
    if (cuts.length === 0) {
      errors.push("No cuts defined in composition");
      return this._result(errors, warnings, info, start);
    }

    // --- Check 2: Video duration ---
    let videoDuration = 0.0;
    for (const cut of cuts) {
      const outS = (cut.out_seconds as number) ?? 0;
      if (outS > videoDuration) {
        videoDuration = outS;
      }
    }
    info.push(`Video duration: ${pyNum(videoDuration)}s (${cuts.length} cuts)`);
    info.push(
      `Render runtime: ${runtime || "default (remotion)"}; assets root: ${assetsRoot}`
    );

    // --- Check 3: Cut ordering and gaps ---
    const sortedCuts = [...cuts].sort(
      (a, b) =>
        ((a.in_seconds as number) ?? 0) - ((b.in_seconds as number) ?? 0)
    );
    for (let i = 0; i < sortedCuts.length; i++) {
      const cut = sortedCuts[i]!;
      const inS = (cut.in_seconds as number) ?? 0;
      const outS = (cut.out_seconds as number) ?? 0;
      if (outS <= inS) {
        errors.push(
          `Cut '${cut.id ?? i}': out_seconds (${pyNum(outS)}) <= in_seconds (${pyNum(inS)})`
        );
      }
    }

    // --- Check 4: Asset files exist ---
    for (const cut of cuts) {
      const source = (cut.source as string) ?? "";
      if (source) {
        const assetPath = path.join(assetsRoot, source);
        if (!fs.existsSync(assetPath)) {
          errors.push(`Missing asset: ${source} (looked in ${assetsRoot})`);
        }
      }

      const bgImg = (cut.backgroundImage as string) ?? "";
      if (bgImg) {
        const bgPath = path.join(assetsRoot, bgImg);
        if (!fs.existsSync(bgPath)) {
          errors.push(`Missing background image: ${bgImg}`);
        }
      }
    }

    // --- Check 5: Narration duration vs video duration ---
    const narration = (audio.narration as Record<string, unknown>) ?? {};
    const narrationSrc = (narration.src as string) ?? "";
    if (narrationSrc) {
      const narrationPath = path.join(assetsRoot, narrationSrc);
      if (!fs.existsSync(narrationPath)) {
        errors.push(`Missing narration audio: ${narrationSrc}`);
      } else {
        const narrationDur = await probeDuration(narrationPath);
        if (narrationDur !== null) {
          info.push(`Narration duration: ${narrationDur.toFixed(1)}s`);
          const overshoot = narrationDur - videoDuration;
          if (overshoot > 1.0) {
            errors.push(
              `Narration (${narrationDur.toFixed(1)}s) exceeds video (${pyNum(videoDuration)}s) ` +
                `by ${overshoot.toFixed(1)}s — audio will be cut off`
            );
          } else if (overshoot > 0) {
            warnings.push(
              `Narration (${narrationDur.toFixed(1)}s) slightly exceeds video (${pyNum(videoDuration)}s) ` +
                `by ${overshoot.toFixed(1)}s`
            );
          }
        } else {
          warnings.push(`Could not probe narration duration: ${narrationSrc}`);
        }
      }
    }

    // --- Check 6: Music duration ---
    const music = (audio.music as Record<string, unknown>) ?? {};
    const musicSrc = (music.src as string) ?? "";
    if (musicSrc) {
      const musicPath = path.join(assetsRoot, musicSrc);
      if (!fs.existsSync(musicPath)) {
        errors.push(`Missing music audio: ${musicSrc}`);
      } else {
        const musicDur = await probeDuration(musicPath);
        if (musicDur !== null) {
          info.push(`Music duration: ${musicDur.toFixed(1)}s`);
          if (musicDur < videoDuration) {
            warnings.push(
              `Music (${musicDur.toFixed(1)}s) is shorter than video (${pyNum(videoDuration)}s) ` +
                `— will end early`
            );
          }
        }
      }
    }

    // --- Check 7: No audio at all ---
    if (!narrationSrc && !musicSrc) {
      warnings.push("No audio configured (no narration or music)");
    }

    return this._result(errors, warnings, info, start);
  }

  private _result(
    errors: string[],
    warnings: string[],
    info: string[],
    start: number
  ): ToolResult {
    const passed = errors.length === 0;
    const data = {
      valid: passed,
      errors,
      warnings,
      info,
      error_count: errors.length,
      warning_count: warnings.length,
    };

    if (!passed) {
      const summary = errors.slice(0, 3).join("; ");
      return toolResult({
        success: false,
        error: `Composition has ${errors.length} error(s): ${summary}`,
        data,
        duration_seconds: round((Date.now() - start) / 1000, 2),
      });
    }

    return toolResult({
      success: true,
      data,
      duration_seconds: round((Date.now() - start) / 1000, 2),
    });
  }
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Mirror Python's default number-to-string: ints print without a trailing .0. */
function pyNum(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
