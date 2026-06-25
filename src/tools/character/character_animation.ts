/**
 * Local character-animation contract tools (TypeScript port).
 *
 * 1:1 port of tools/character/character_animation.py. These tools provide
 * deterministic artifact generation and validation for the character-animation
 * pipeline. They intentionally keep creative orchestration in skills and
 * manifests; this module only creates structured artifacts and lightweight
 * preview/review outputs.
 *
 * All six tools are LOCAL logic tools (provider="montagent",
 * capability="character_animation"). Output JSON / SVG / HTML structure is
 * matched verbatim against the Python implementation.
 *
 * Parity notes vs. Python:
 *  - `validate_artifact` -> `validateArtifact` (src/lib/schema_validator.ts);
 *    the same JSON Schemas under schemas/ validate the same artifacts. A failed
 *    validation throws, and its message is captured into the QA report's issues
 *    list exactly like the Python `except Exception as exc` branch.
 *  - The optional preview-MP4 render (character_rig_renderer with render_video)
 *    mirrors the Python `_render_preview_mp4`: it requires ffmpeg on PATH and
 *    lazily imports Playwright, raising a RuntimeError-equivalent (Error) when
 *    either is unavailable. Playwright is NOT a project dependency, so the
 *    import is dynamic — the default artifact-generation path never touches it.
 *  - Python float formatting (`f"{x:.1f}"`, `f"{d:.3f}"`) maps to
 *    Number#toFixed(1) / toFixed(3); `round(x, 2)` maps to the helper `round2`.
 *  - dict.setdefault, sorted(set(...)), and `**({...} if cond else {})` spreads
 *    are reproduced with the same insertion/sort semantics.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  BaseTool,
  Determinism,
  ExecutionMode,
  ResourceProfile,
  ToolResult,
  ToolStability,
  ToolTier,
  commandExists,
  toolResult,
} from "../base_tool.js";
import { validateArtifact } from "../../lib/schema_validator.js";

// ---------------------------------------------------------------------------
// Module-level helpers (mirror the private functions in the Python module).
// ---------------------------------------------------------------------------

/** round(value, 2) — Python banker's rounding is not relied upon here. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Mirror of `_write_json`: write pretty JSON (indent=2) and return [path]. */
function writeJson(p: string | undefined, data: Record<string, unknown>): string[] {
  if (!p) {
    return [];
  }
  const out = path.resolve(p);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(data, null, 2), "utf-8");
  return [out];
}

/**
 * Mirror of `_slug`:
 *   chars = [c.lower() if c.isalnum() else "-" for c in value.strip()]
 *   "-".join("".join(chars).split("-")).strip("-") or "character"
 * i.e. lowercase alphanumerics, every other char becomes "-", collapse runs of
 * "-" to a single "-", strip leading/trailing "-", default to "character".
 */
function slug(value: string): string {
  const trimmed = value.trim();
  const chars: string[] = [];
  for (const c of trimmed) {
    chars.push(isAlnum(c) ? c.toLowerCase() : "-");
  }
  const joined = chars.join("");
  // "".split("-") in Python drops empty segments only via join("-"); but
  // Python's str.split("-") keeps empties — the join then collapses runs
  // because "-".join([...]) re-inserts a single "-" between every segment.
  // Replicate exactly: split on "-", join with "-" filters empty runs because
  // consecutive "-" produce empty strings which, when re-joined, must collapse.
  // Python "a--b".split("-") -> ["a", "", "b"]; "-".join(...) -> "a--b" (NOT
  // collapsed). The collapsing actually comes from filtering empties:
  //   "".join(chars).split("-") with Python semantics keeps empties, but the
  //   surrounding code relies on .split() default? No — it is split("-").
  // Re-checking Python: "-".join("".join(chars).split("-")) is an identity on
  // the runs; the REAL collapse + strip happens via .strip("-") only at ends.
  // However "a--b".split("-") == ["a","","b"] and "-".join(["a","","b"]) ==
  // "a--b" — so internal runs are preserved. To match byte-for-byte we must
  // therefore NOT collapse internal runs.
  const segments = joined.split("-");
  const rejoined = segments.join("-");
  const stripped = stripDashes(rejoined);
  return stripped || "character";
}

/** Python str.isalnum(): True if all chars are alphanumeric and there is >=1. */
function isAlnum(ch: string): boolean {
  // Single-character check; mirror Python's Unicode-aware isalnum for the ASCII
  // + common letter/number range. Use a Unicode property escape.
  return /[\p{L}\p{N}]/u.test(ch);
}

/** Python str.strip("-"): remove leading/trailing "-" only. */
function stripDashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "-") start += 1;
  while (end > start && value[end - 1] === "-") end -= 1;
  return value.slice(start, end);
}

/** Mirror of `_character_color`: returns [body_fill, head_fill]. */
function characterColor(index: number): [string, string] {
  const palettes: Array<[string, string]> = [
    ["#ff8f68", "#ffd39f"],
    ["#75b8ff", "#ffe7a3"],
    ["#8fd17f", "#f7c8ff"],
    ["#f2c94c", "#fce6c9"],
  ];
  // Python modulo on a non-negative index; palettes length is 4.
  return palettes[((index % palettes.length) + palettes.length) % palettes.length]!;
}

/** Mirror of `_normalize_style`. */
function normalizeStyle(style: unknown): Record<string, unknown> {
  if (typeof style !== "object" || style === null || Array.isArray(style)) {
    return {};
  }
  const s = style as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  const visualStyle = s["visual_style"] || s["name"] || s["style"];
  if (visualStyle) {
    normalized["visual_style"] = String(visualStyle);
  }
  const palette = s["palette"];
  if (Array.isArray(palette)) {
    normalized["palette"] = palette.map((color) => String(color));
  }
  for (const key of ["line_style", "texture"]) {
    if (s[key]) {
      normalized[key] = String(s[key]);
    }
  }
  return normalized;
}

/** Python str.title(): capitalize first letter of each alphabetic run. */
function titleCase(value: string): string {
  return value.replace(/[A-Za-z]+/g, (word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase());
}

/**
 * Mirror of `_render_preview_mp4`. Requires ffmpeg on PATH and Playwright
 * (lazily imported, exactly like the Python `from playwright.sync_api import
 * sync_playwright` inside the function). Throws on missing deps / ffmpeg
 * failure, matching the Python RuntimeError contract.
 */
async function renderPreviewMp4(
  previewPath: string,
  videoPath: string,
  durationSeconds: number,
  fps: number
): Promise<void> {
  if (!commandExists("ffmpeg")) {
    throw new Error("ffmpeg is required to render preview MP4");
  }
  let chromium: {
    launch: () => Promise<{
      newPage: (opts: { viewport: { width: number; height: number } }) => Promise<{
        goto: (url: string, opts: { waitUntil: string }) => Promise<unknown>;
        waitForTimeout: (ms: number) => Promise<unknown>;
        screenshot: (opts: { path: string }) => Promise<unknown>;
      }>;
      close: () => Promise<unknown>;
    }>;
  };
  try {
    // Dynamic import via a computed specifier so tsc/NodeNext does not try to
    // statically resolve this optional, undeclared dependency.
    const playwrightSpecifier = "playwright";
    const pw = (await import(playwrightSpecifier)) as unknown as {
      chromium: typeof chromium;
    };
    chromium = pw.chromium;
  } catch (exc) {
    throw new Error(
      `Playwright is required to render preview MP4: ${(exc as Error).message ?? exc}`
    );
  }

  const frameDir = path.join(
    path.dirname(videoPath),
    `${path.basename(videoPath, path.extname(videoPath))}_frames`
  );
  fs.mkdirSync(frameDir, { recursive: true });
  const frameCount = Math.max(2, Math.trunc(durationSeconds * fps));

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(pathToFileURL(path.resolve(previewPath)).href, { waitUntil: "networkidle" });
  for (let frame = 0; frame < frameCount; frame += 1) {
    if (frame) {
      await page.waitForTimeout(Math.trunc(1000 / fps));
    }
    await page.screenshot({
      path: path.join(frameDir, `frame_${String(frame).padStart(4, "0")}.png`),
    });
  }
  await browser.close();

  const { execa } = await import("execa");
  const result = await execa(
    "ffmpeg",
    [
      "-y",
      "-framerate",
      String(fps),
      "-i",
      path.join(frameDir, "frame_%04d.png"),
      "-r",
      String(fps),
      "-pix_fmt",
      "yuv420p",
      videoPath,
    ],
    { reject: false }
  );
  if (result.exitCode !== 0) {
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
    throw new Error(stderr || "ffmpeg failed to render preview MP4");
  }
}

// ---------------------------------------------------------------------------
// Tool 1: character_spec_generator
// ---------------------------------------------------------------------------
export class CharacterSpecGenerator extends BaseTool {
  override name = "character_spec_generator";
  override version = "0.1.0";
  override tier = ToolTier.CORE;
  override capability = "character_animation";
  override provider = "montagent";
  override stability = ToolStability.BETA;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;
  override resource_profile: ResourceProfile = {
    cpu_cores: 1,
    ram_mb: 128,
    vram_mb: 0,
    disk_mb: 10,
    network_required: false,
  };
  override agent_skills = ["character-rigging", "pose-library-design"];
  override capabilities = ["draft_character_design", "normalize_character_specs"];
  override best_for = ["Converting approved concepts into structured character_design artifacts"];
  override not_good_for = ["Generating artwork pixels or finished animation"];
  override input_schema = {
    type: "object",
    properties: {
      characters: { type: "array" },
      brief: { type: "string" },
      style: { type: "object" },
      output_path: { type: "string" },
    },
  };
  override output_schema = { type: "object", properties: { character_design: { type: "object" } } };
  override artifact_schema = { artifact: "character_design" };
  override side_effects = ["optionally writes character_design JSON to output_path"];
  override user_visible_verification = ["Review character count, action list, and emotional range"];

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const start = Date.now();
    const style = (inputs["style"] as Record<string, unknown>) ?? {};
    const rawCharacters =
      (inputs["characters"] as Array<Record<string, unknown>>) ||
      [
        {
          id: "main_character",
          role: "lead character",
          body_type: "simple rounded cartoon character",
          style: "local rigged cartoon",
          required_emotions: ["neutral", "curious", "happy", "surprised"],
          required_actions: ["idle", "blink", "look", "gesture"],
        },
      ];
    const characters: Array<Record<string, unknown>> = [];
    for (const raw of rawCharacters) {
      const name = raw["id"] || raw["name"] || raw["display_name"] || "character";
      characters.push({
        id: slug(String(name)),
        display_name:
          raw["display_name"] !== undefined
            ? raw["display_name"]
            : titleCase(String(name).replace(/_/g, " ")),
        role: raw["role"] !== undefined ? raw["role"] : "supporting character",
        body_type: raw["body_type"] !== undefined ? raw["body_type"] : "simple cartoon body",
        style:
          raw["style"] !== undefined
            ? raw["style"]
            : ((style["visual_style"] as unknown) ?? "cartoon"),
        silhouette_notes: raw["silhouette_notes"] !== undefined ? raw["silhouette_notes"] : "",
        required_emotions:
          raw["required_emotions"] !== undefined
            ? raw["required_emotions"]
            : ["neutral", "happy", "surprised"],
        required_actions:
          raw["required_actions"] !== undefined
            ? raw["required_actions"]
            : ["idle", "blink", "look"],
        required_views:
          raw["required_views"] !== undefined ? raw["required_views"] : ["front", "side"],
        props: raw["props"] !== undefined ? raw["props"] : [],
        constraints: raw["constraints"] !== undefined ? raw["constraints"] : [],
      });
    }
    const artifact: Record<string, unknown> = {
      version: "1.0",
      style: normalizeStyle(inputs["style"] ?? {}),
      characters,
      metadata: {
        source: "character_spec_generator",
        brief: inputs["brief"] !== undefined ? inputs["brief"] : "",
      },
    };
    const artifacts = writeJson(inputs["output_path"] as string | undefined, artifact);
    return toolResult({
      success: true,
      data: { character_design: artifact },
      artifacts,
      duration_seconds: round2((Date.now() - start) / 1000),
    });
  }
}

// ---------------------------------------------------------------------------
// Tool 2: svg_rig_builder
// ---------------------------------------------------------------------------
type BasePart = [string, string, number, string | null, [number, number]];

export class SvgRigBuilder extends BaseTool {
  override name = "svg_rig_builder";
  override version = "0.1.0";
  override tier = ToolTier.CORE;
  override capability = "character_animation";
  override provider = "montagent";
  override stability = ToolStability.BETA;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;
  override resource_profile: ResourceProfile = {
    cpu_cores: 1,
    ram_mb: 128,
    vram_mb: 0,
    disk_mb: 10,
    network_required: false,
  };
  override agent_skills = [
    "character-rigging",
    "svg-character-animation",
    "gsap-core",
    "gsap-timeline",
  ];
  override capabilities = ["draft_svg_rig_plan", "define_parts_pivots_layers"];
  override input_schema = {
    type: "object",
    required: ["character_design"],
    properties: {
      character_design: { type: "object" },
      output_path: { type: "string" },
    },
  };
  override artifact_schema = { artifact: "rig_plan" };
  override side_effects = ["optionally writes rig_plan JSON to output_path"];
  override user_visible_verification = ["Check pivots and layers before asset generation"];

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const start = Date.now();
    const design = inputs["character_design"] as Record<string, unknown>;
    const rigCharacters: Array<Record<string, unknown>> = [];
    const designCharacters = (design["characters"] as Array<Record<string, unknown>>) ?? [];
    for (const character of designCharacters) {
      const cid = character["id"] as string;
      const actions = (character["required_actions"] as string[]) ?? [];
      const baseParts: BasePart[] = [
        ["body", "torso", 20, null, [320, 380]],
        ["head", "head", 40, "body", [320, 220]],
        ["eye_left", "eye", 50, "head", [288, 210]],
        ["eye_right", "eye", 50, "head", [352, 210]],
        ["pupil_left", "pupil", 51, "eye_left", [288, 210]],
        ["pupil_right", "pupil", 51, "eye_right", [352, 210]],
        ["mouth", "mouth", 52, "head", [320, 260]],
        ["arm_left", "limb", 35, "body", [260, 330]],
        ["arm_right", "limb", 35, "body", [380, 330]],
        ["leg_left", "limb", 10, "body", [285, 470]],
        ["leg_right", "limb", 10, "body", [355, 470]],
      ];
      const bodyType = ((character["body_type"] as string) ?? "").toLowerCase();
      if (bodyType.includes("tail") || cid.includes("mouse")) {
        baseParts.push(["tail", "tail", 5, "body", [245, 425]]);
      }
      if (actions.some((a) => a.includes("wing")) || cid.includes("bird")) {
        baseParts.push(
          ["wing_left", "wing", 30, "body", [275, 330]],
          ["wing_right", "wing", 30, "body", [365, 330]]
        );
      }
      const parts = baseParts.map(([partId, kind, layer, parent]) => {
        const part: Record<string, unknown> = { id: partId, kind, layer };
        if (parent) {
          part["parent"] = parent;
        }
        return part;
      });
      const joints: Record<string, unknown> = {};
      for (const [partId, kind, , , pivot] of baseParts) {
        joints[partId] = {
          pivot,
          rotation: kind === "head" || kind === "tail" ? [-35, 35] : [-75, 95],
          scale: [0.8, 1.2],
        };
      }
      const requiredPoses = Array.from(
        new Set(["idle", "blink", "look_left", "look_right", "surprised", ...actions])
      ).sort();
      // layers = ids ordered by ascending layer (stable, matching Python sorted()).
      const layers = parts
        .map((p, idx) => ({ p, idx }))
        .sort((a, b) => (a.p["layer"] as number) - (b.p["layer"] as number) || a.idx - b.idx)
        .map((entry) => entry.p["id"] as string);
      rigCharacters.push({
        character_id: cid,
        rig_type: "svg_rig",
        parts,
        joints,
        layers,
        views: (character["required_views"] as unknown) ?? ["front", "side"],
        required_poses: requiredPoses,
        required_actions: actions,
        risks: ["Generated pivots are first-pass estimates; review with preview frames."],
      });
    }
    const artifact: Record<string, unknown> = {
      version: "1.0",
      characters: rigCharacters,
      metadata: { source: this.name },
    };
    const artifacts = writeJson(inputs["output_path"] as string | undefined, artifact);
    return toolResult({
      success: true,
      data: { rig_plan: artifact },
      artifacts,
      duration_seconds: round2((Date.now() - start) / 1000),
    });
  }
}

// ---------------------------------------------------------------------------
// Tool 3: pose_library_builder
// ---------------------------------------------------------------------------
export class PoseLibraryBuilder extends BaseTool {
  override name = "pose_library_builder";
  override version = "0.1.0";
  override tier = ToolTier.CORE;
  override capability = "character_animation";
  override provider = "montagent";
  override stability = ToolStability.BETA;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;
  override resource_profile: ResourceProfile = {
    cpu_cores: 1,
    ram_mb: 128,
    vram_mb: 0,
    disk_mb: 10,
    network_required: false,
  };
  override agent_skills = ["pose-library-design", "character-rigging", "svg-character-animation"];
  override capabilities = ["draft_pose_library", "draft_action_cycles"];
  override input_schema = {
    type: "object",
    required: ["rig_plan"],
    properties: { rig_plan: { type: "object" }, output_path: { type: "string" } },
  };
  override artifact_schema = { artifact: "pose_library" };
  override side_effects = ["optionally writes pose_library JSON to output_path"];

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const start = Date.now();
    const characters: Array<Record<string, unknown>> = [];
    const rigPlan = inputs["rig_plan"] as Record<string, unknown>;
    const rigCharacters = (rigPlan["characters"] as Array<Record<string, unknown>>) ?? [];
    for (const rig of rigCharacters) {
      const cid = rig["character_id"] as string;
      const poses: Record<string, Record<string, unknown>> = {
        idle: { description: "Neutral readable hold", parts: {}, hold_frames: 24 },
        blink: {
          description: "Quick eye close/open",
          parts: { eye_left: { scaleY: 0.08 }, eye_right: { scaleY: 0.08 } },
          hold_frames: 3,
          transition: "power1.inOut",
        },
        look_left: {
          description: "Gaze shifts left",
          parts: { pupil_left: { x: -6 }, pupil_right: { x: -6 } },
          hold_frames: 18,
        },
        look_right: {
          description: "Gaze shifts right",
          parts: { pupil_left: { x: 6 }, pupil_right: { x: 6 } },
          hold_frames: 18,
        },
        surprised: {
          description: "Head lifts, eyes widen, mouth opens",
          parts: { head: { y: -4, rotation: -4 }, mouth: { shape: "small_o" } },
          expression: "surprised",
          hold_frames: 24,
          transition: "back.out",
        },
      };
      const requiredActions = (rig["required_actions"] as string[]) ?? [];
      for (const action of requiredActions) {
        // dict.setdefault: only add when the key is absent.
        if (!(action in poses)) {
          poses[action] = {
            description: `First-pass pose for ${action}`,
            parts: {},
            hold_frames: 18,
            transition: "power2.inOut",
          };
        }
      }
      characters.push({
        character_id: cid,
        poses,
        mouth_shapes: {
          closed: { description: "Neutral closed mouth" },
          small_o: { description: "Small open mouth for surprise or vowel" },
          wide: { description: "Wide open mouth" },
          smile: { description: "Smile shape" },
        },
        action_cycles: {
          walk: ["walk_contact", "walk_passing"],
          breathe: ["idle"],
        },
      });
    }
    const artifact: Record<string, unknown> = {
      version: "1.0",
      characters,
      metadata: { source: this.name },
    };
    const artifacts = writeJson(inputs["output_path"] as string | undefined, artifact);
    return toolResult({
      success: true,
      data: { pose_library: artifact },
      artifacts,
      duration_seconds: round2((Date.now() - start) / 1000),
    });
  }
}

// ---------------------------------------------------------------------------
// Tool 4: action_timeline_compiler
// ---------------------------------------------------------------------------
export class ActionTimelineCompiler extends BaseTool {
  override name = "action_timeline_compiler";
  override version = "0.1.0";
  override tier = ToolTier.CORE;
  override capability = "character_animation";
  override provider = "montagent";
  override stability = ToolStability.BETA;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;
  override resource_profile: ResourceProfile = {
    cpu_cores: 1,
    ram_mb: 128,
    vram_mb: 0,
    disk_mb: 10,
    network_required: false,
  };
  override agent_skills = ["pose-library-design", "svg-character-animation", "gsap-timeline"];
  override capabilities = ["compile_scene_actions", "draft_action_timeline"];
  override input_schema = {
    type: "object",
    required: ["scene_plan"],
    properties: {
      scene_plan: { type: "object" },
      character_ids: { type: "array", items: { type: "string" } },
      fps: { type: "number" },
      output_path: { type: "string" },
    },
  };
  override artifact_schema = { artifact: "action_timeline" };
  override side_effects = ["optionally writes action_timeline JSON to output_path"];

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const start = Date.now();
    const characterIds = (inputs["character_ids"] as string[]) || ["main_character"];
    const scenes: Array<Record<string, unknown>> = [];
    const scenePlan = inputs["scene_plan"] as Record<string, unknown>;
    const planScenes = (scenePlan["scenes"] as Array<Record<string, unknown>>) ?? [];
    for (const scene of planScenes) {
      const startS = (scene["start_seconds"] as number) ?? 0;
      const endS = (scene["end_seconds"] as number) ?? startS + 3;
      const duration = Math.max(0.1, endS - startS);
      const actions: Array<Record<string, unknown>> = [];
      characterIds.forEach((characterId, index) => {
        const offset = Math.min(duration * 0.08 * index, duration * 0.2);
        const isPrimary = index === 0;
        actions.push(
          {
            at_seconds: startS + offset,
            duration_seconds: Math.min(0.5, duration / 4),
            character_id: characterId,
            action: isPrimary ? "anticipate" : "react",
            pose: "idle",
            easing: "power2.out",
          },
          {
            at_seconds: startS + duration * 0.25 + offset,
            duration_seconds: duration * 0.35,
            character_id: characterId,
            action: isPrimary ? "perform" : "follow",
            pose: scene["hero_moment"] || !isPrimary ? "surprised" : "look_right",
            easing: "back.out",
            notes: scene["description"] !== undefined ? scene["description"] : "",
          },
          {
            at_seconds: startS + duration * 0.7 + offset,
            duration_seconds: duration * 0.25,
            character_id: characterId,
            action: "settle",
            pose: "idle",
            easing: "power2.inOut",
          }
        );
      });
      scenes.push({
        scene_id: scene["id"],
        start_seconds: startS,
        end_seconds: endS,
        camera: { framing: scene["framing"] !== undefined ? scene["framing"] : "medium" },
        background: scene["description"] !== undefined ? scene["description"] : "",
        effects: [],
        actions,
      });
    }
    const artifact: Record<string, unknown> = {
      version: "1.0",
      fps: inputs["fps"] !== undefined ? inputs["fps"] : 30,
      scenes,
      metadata: { source: this.name },
    };
    const artifacts = writeJson(inputs["output_path"] as string | undefined, artifact);
    return toolResult({
      success: true,
      data: { action_timeline: artifact },
      artifacts,
      duration_seconds: round2((Date.now() - start) / 1000),
    });
  }
}

// ---------------------------------------------------------------------------
// Tool 5: character_rig_renderer
// ---------------------------------------------------------------------------
export class CharacterRigRenderer extends BaseTool {
  override name = "character_rig_renderer";
  override version = "0.1.0";
  override tier = ToolTier.CORE;
  override capability = "character_animation";
  override provider = "montagent";
  override stability = ToolStability.BETA;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;
  override resource_profile: ResourceProfile = {
    cpu_cores: 1,
    ram_mb: 128,
    vram_mb: 0,
    disk_mb: 50,
    network_required: false,
  };
  override agent_skills = [
    "character-rigging",
    "svg-character-animation",
    "canvas-procedural-animation",
    "gsap-core",
    "gsap-timeline",
    "remotion-best-practices",
    "hyperframes",
  ];
  override capabilities = ["write_browser_preview", "prepare_character_render_package"];
  override input_schema = {
    type: "object",
    required: ["action_timeline"],
    properties: {
      action_timeline: { type: "object" },
      rig_plan: { type: "object" },
      pose_library: { type: "object" },
      output_path: { type: "string" },
      workspace_path: { type: "string" },
      video_output_path: { type: "string" },
      render_video: { type: "boolean", default: false },
      duration_seconds: { type: "number", minimum: 0.1, default: 3 },
      fps: { type: "integer", minimum: 1, default: 12 },
    },
  };
  override output_schema = {
    type: "object",
    properties: {
      preview_path: { type: "string" },
      hyperframes_workspace: { type: "string" },
      composition_path: { type: "string" },
      video_path: { type: "string" },
      asset_manifest: { type: "object" },
      edit_decisions: { type: "object" },
    },
  };
  override side_effects = [
    "writes a lightweight HTML preview to output_path",
    "writes a HyperFrames workspace/package",
    "optionally writes preview MP4",
  ];
  override user_visible_verification = [
    "Open preview and check character visibility and motion",
  ];

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const start = Date.now();
    const actionTimeline = inputs["action_timeline"] as Record<string, unknown>;
    const outputPath = path.resolve(
      (inputs["output_path"] as string) ?? "projects/character-preview/preview.html"
    );
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const timelineJson = JSON.stringify(actionTimeline);
    const timelineScenes = (actionTimeline["scenes"] as Array<Record<string, unknown>>) ?? [];

    let rigCharacters =
      ((inputs["rig_plan"] as Record<string, unknown> | undefined) ?? {})["characters"] as
        | Array<Record<string, unknown>>
        | undefined;
    if (!rigCharacters || rigCharacters.length === 0) {
      const seenIds = new Set<string>();
      for (const scene of timelineScenes) {
        const sceneActions = (scene["actions"] as Array<Record<string, unknown>>) ?? [];
        for (const action of sceneActions) {
          if (action["character_id"]) {
            seenIds.add(action["character_id"] as string);
          }
        }
      }
      const sortedIds = Array.from(seenIds).sort();
      rigCharacters =
        sortedIds.length > 0
          ? sortedIds.map((cid) => ({ character_id: cid }))
          : [{ character_id: "main_character" }];
    }
    const count = rigCharacters.length;
    const spacing = 620 / Math.max(count, 1);
    const characterSvgs: string[] = [];
    rigCharacters.forEach((character, index) => {
      const cid = slug((character["character_id"] as string) ?? `character-${index + 1}`);
      const x = count > 1 ? 110 + spacing * index : 320;
      const scale = count > 1 ? 0.82 : 1;
      const [bodyFill, headFill] = characterColor(index);
      characterSvgs.push(
        `
      <g class="character" id="character_${cid}" data-character="${cid}" transform="translate(${(x - 320).toFixed(1)} 0) scale(${scale})">
        <ellipse class="shadow" cx="320" cy="560" rx="120" ry="22" fill="rgba(0,0,0,.18)" />
        <ellipse class="body outline" cx="320" cy="400" rx="80" ry="120" fill="${bodyFill}" />
        <circle class="head outline" cx="320" cy="230" r="90" fill="${headFill}" />
        <ellipse class="eye eye-left outline" cx="285" cy="215" rx="18" ry="26" fill="white" />
        <ellipse class="eye eye-right outline" cx="355" cy="215" rx="18" ry="26" fill="white" />
        <circle class="pupil pupil-left" cx="289" cy="218" r="8" fill="#202632" />
        <circle class="pupil pupil-right" cx="359" cy="218" r="8" fill="#202632" />
        <path class="mouth outline" d="M285 275 Q320 305 355 275" fill="none" />
        <path class="arm arm-left outline" d="M255 360 C210 380 190 420 180 455" fill="none" />
        <path class="arm arm-right outline" d="M385 360 C440 330 465 290 475 240" fill="none" />
      </g>`
      );
    });
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Character Animation Preview</title>
  <script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>
  <style>
    body { margin: 0; overflow: hidden; background: #9bd7ff; font-family: system-ui, sans-serif; }
    #stage { width: 100vw; height: 100vh; display: grid; place-items: center; background: linear-gradient(#9bd7ff 0 65%, #75c878 65%); }
    svg { width: min(82vw, 720px); overflow: visible; }
    .outline { stroke: #202632; stroke-width: 7; stroke-linecap: round; stroke-linejoin: round; }
    #note { position: fixed; left: 16px; bottom: 16px; background: white; border: 2px solid #202632; padding: 10px 12px; border-radius: 8px; }
  </style>
</head>
<body>
  <div id="stage">
    <svg viewBox="0 0 640 640" role="img" aria-label="Character preview">
${characterSvgs.join("")}
    </svg>
  </div>
  <div id="note">Local character preview. Characters: <span id="characters"></span> · Scenes: <span id="count"></span></div>
  <script>
    window.__ACTION_TIMELINE__ = ${timelineJson};
    document.querySelector('#count').textContent = window.__ACTION_TIMELINE__.scenes.length;
    const characters = gsap.utils.toArray('.character');
    document.querySelector('#characters').textContent = characters.map((node) => node.dataset.character).join(', ');
    characters.forEach((node, index) => {
      const q = gsap.utils.selector(node);
      gsap.set(q('.head'), { svgOrigin: '320 320' });
      gsap.set(q('.arm-right'), { svgOrigin: '385 360' });
      gsap.set(q('.arm-left'), { svgOrigin: '255 360' });
      gsap.timeline({ repeat: -1, defaults: { ease: 'power2.inOut' }, delay: index * 0.12 })
        .to(node, { y: -16, duration: 0.45 })
        .to(node, { y: 0, duration: 0.45 });
      gsap.timeline({ repeat: -1, repeatDelay: 0.5, delay: index * 0.18 })
        .to(q('.head'), { rotation: index % 2 ? 8 : -8, duration: 0.35 })
        .to(q('.pupil'), { x: index % 2 ? -8 : 8, y: -3, duration: 0.2 }, '<')
        .to(q('.arm-right'), { rotation: index % 2 ? -22 : 28, duration: 0.35 }, '<')
        .to(q('.eye'), { scaleY: 0.08, transformOrigin: 'center', duration: 0.08 })
        .to(q('.eye'), { scaleY: 1, duration: 0.1 })
        .to(q('.head'), { rotation: index % 2 ? -6 : 6, duration: 0.35 })
        .to(q('.pupil'), { x: index % 2 ? 6 : -6, y: 3, duration: 0.2 }, '<')
        .to(q('.arm-right'), { rotation: index % 2 ? 8 : -8, duration: 0.35 }, '<');
    });
        </script>
</body>
</html>
`;
    fs.writeFileSync(outputPath, html, "utf-8");

    const endSecondsValues = timelineScenes.map(
      (scene) => Number((scene["end_seconds"] as number) || 0) || 0
    );
    const totalDuration = Math.max(
      ...(endSecondsValues.length > 0
        ? endSecondsValues
        : [Number((inputs["duration_seconds"] as number) ?? 3)])
    );

    const workspacePath = path.resolve(
      (inputs["workspace_path"] as string) ?? path.join(path.dirname(outputPath), "hyperframes")
    );
    const compositionDir = path.join(workspacePath, "compositions");
    fs.mkdirSync(compositionDir, { recursive: true });
    fs.mkdirSync(path.join(workspacePath, "assets"), { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, "hyperframes.json"),
      JSON.stringify(
        {
          registry: "https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry",
          paths: {
            blocks: "compositions",
            components: "compositions/components",
            assets: "assets",
          },
        },
        null,
        2
      ),
      "utf-8"
    );
    fs.writeFileSync(
      path.join(workspacePath, "DESIGN.md"),
      "# DESIGN\n\n" +
        "Generated for Montagent character animation.\n\n" +
        "- Background: `#9bd7ff` sky and `#75c878` ground\n" +
        "- Foreground: `#202632` ink outlines\n" +
        "- Accent: saturated cartoon body colors\n" +
        "- Motion: GSAP pose holds, squash/bounce, gaze, blink, and arm arcs\n",
      "utf-8"
    );
    const finiteBounceRepeats = Math.max(0, Math.trunc(totalDuration / 0.9) - 1);
    const finiteActingRepeats = Math.max(0, Math.trunc(totalDuration / 2.1) - 1);
    const compositionHtml = `<template id="character-scene-template">
  <div data-composition-id="character-scene" data-start="0" data-duration="${totalDuration.toFixed(
    3
  )}" data-width="1280" data-height="720">
    <style>
      [data-composition-id="character-scene"] { position: relative; width: 1280px; height: 720px; overflow: hidden; background: linear-gradient(#9bd7ff 0 65%, #75c878 65%); }
      [data-composition-id="character-scene"] svg { width: 920px; position: absolute; left: 180px; top: 42px; overflow: visible; }
      [data-composition-id="character-scene"] .outline { stroke: #202632; stroke-width: 7; stroke-linecap: round; stroke-linejoin: round; }
    </style>
    <svg viewBox="0 0 640 640" role="img" aria-label="Character animation scene">
${characterSvgs.join("")}
    </svg>
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      const characters = gsap.utils.toArray('[data-composition-id="character-scene"] .character');
      characters.forEach((node, index) => {
        const q = gsap.utils.selector(node);
        tl.set(q('.head'), { svgOrigin: '320 320' }, 0);
        tl.set(q('.arm-right'), { svgOrigin: '385 360' }, 0);
        tl.set(q('.arm-left'), { svgOrigin: '255 360' }, 0);
        tl.from(node, { y: 26, scale: 0.94, opacity: 0, duration: 0.45, ease: 'back.out(1.8)' }, 0.15 + index * 0.12);
        tl.to(node, { y: -16, duration: 0.45, repeat: ${finiteBounceRepeats}, yoyo: true, ease: 'power2.inOut' }, 0.7 + index * 0.08);
        tl.to(q('.head'), { rotation: index % 2 ? 8 : -8, duration: 0.35, repeat: ${finiteActingRepeats}, yoyo: true, ease: 'sine.inOut' }, 0.55 + index * 0.16);
        tl.to(q('.pupil'), { x: index % 2 ? -8 : 8, y: -3, duration: 0.2, repeat: ${finiteActingRepeats}, yoyo: true, ease: 'power2.inOut' }, 0.6 + index * 0.16);
        tl.to(q('.arm-right'), { rotation: index % 2 ? -22 : 28, duration: 0.35, repeat: ${finiteActingRepeats}, yoyo: true, ease: 'back.inOut(1.4)' }, 0.65 + index * 0.16);
        tl.to(q('.eye'), { scaleY: 0.08, transformOrigin: 'center', duration: 0.08, repeat: ${finiteActingRepeats}, repeatDelay: 1.4, yoyo: true, ease: 'power1.inOut' }, 1.1 + index * 0.12);
      });
      window.__timelines['character-scene'] = tl;
    </script>
  </div>
</template>
`;
    const compositionPath = path.join(compositionDir, "character-scene.html");
    fs.writeFileSync(compositionPath, compositionHtml, "utf-8");
    const assetId = "character_scene_hyperframes";
    const assetManifest: Record<string, unknown> = {
      version: "1.0",
      assets: [
        {
          id: assetId,
          type: "animation",
          path: compositionPath,
          source_tool: this.name,
          scene_id: "character_preview",
          duration_seconds: totalDuration,
          format: "html",
          generation_summary: "HyperFrames SVG/GSAP character composition package.",
        },
      ],
      total_cost_usd: 0,
      metadata: { source: this.name, workspace_path: workspacePath },
    };
    const editDecisions: Record<string, unknown> = {
      version: "1.0",
      render_runtime: "hyperframes",
      renderer_family: "animation-first",
      cuts: [
        {
          id: "character-scene",
          source: assetId,
          in_seconds: 0,
          out_seconds: totalDuration,
          reason: "HyperFrames SVG/GSAP character scene generated by character_rig_renderer.",
        },
      ],
      metadata: {
        proposal_render_runtime: "hyperframes",
        title: "Character Animation",
      },
    };
    const data: Record<string, unknown> = {
      preview_path: outputPath,
      render_package: "hyperframes_workspace",
      hyperframes_workspace: workspacePath,
      composition_path: compositionPath,
      asset_manifest: assetManifest,
      edit_decisions: editDecisions,
    };
    const artifacts = [outputPath, path.join(workspacePath, "hyperframes.json"), compositionPath];
    const renderVideo = Boolean(inputs["render_video"] || inputs["video_output_path"]);
    if (renderVideo) {
      const videoPath = path.resolve(
        (inputs["video_output_path"] as string) ||
          path.join(
            path.dirname(outputPath),
            `${path.basename(outputPath, path.extname(outputPath))}.mp4`
          )
      );
      fs.mkdirSync(path.dirname(videoPath), { recursive: true });
      const durationSeconds = Number((inputs["duration_seconds"] as number) ?? 3);
      const fps = Math.trunc(Number((inputs["fps"] as number) ?? 12));
      await renderPreviewMp4(outputPath, videoPath, durationSeconds, fps);
      const videoAssetId = `${path.basename(outputPath, path.extname(outputPath))}_preview_video`;
      const videoAssetManifest: Record<string, unknown> = {
        version: "1.0",
        assets: [
          {
            id: videoAssetId,
            type: "video",
            path: videoPath,
            source_tool: this.name,
            scene_id: "character_preview",
            duration_seconds: durationSeconds,
            format: "mp4",
            generation_summary:
              "Rendered from local SVG/GSAP character preview via Playwright frame capture and ffmpeg.",
          },
        ],
        total_cost_usd: 0,
        metadata: { source: this.name, preview_path: outputPath },
      };
      const videoEditDecisions: Record<string, unknown> = {
        version: "1.0",
        render_runtime: "ffmpeg",
        renderer_family: "animation-first",
        cuts: [
          {
            id: "character-preview-cut",
            source: videoAssetId,
            in_seconds: 0,
            out_seconds: durationSeconds,
            reason: "Local rendered character preview for video_compose handoff.",
          },
        ],
        metadata: {
          proposal_render_runtime: "ffmpeg",
          character_preview_path: outputPath,
        },
      };
      data["video_path"] = videoPath;
      data["video_asset_manifest"] = videoAssetManifest;
      data["video_edit_decisions"] = videoEditDecisions;
      artifacts.push(videoPath);
    }
    return toolResult({
      success: true,
      data,
      artifacts,
      duration_seconds: round2((Date.now() - start) / 1000),
    });
  }
}

// ---------------------------------------------------------------------------
// Tool 6: character_animation_reviewer
// ---------------------------------------------------------------------------
export class CharacterAnimationReviewer extends BaseTool {
  override name = "character_animation_reviewer";
  override version = "0.1.0";
  override tier = ToolTier.ANALYZE;
  override capability = "character_animation";
  override provider = "montagent";
  override stability = ToolStability.BETA;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;
  override resource_profile: ResourceProfile = {
    cpu_cores: 1,
    ram_mb: 128,
    vram_mb: 0,
    disk_mb: 10,
    network_required: false,
  };
  override agent_skills = ["character-animation-qa"];
  override capabilities = ["review_character_artifacts", "draft_character_qa_report"];
  override input_schema = {
    type: "object",
    properties: {
      rig_plan: { type: "object" },
      pose_library: { type: "object" },
      action_timeline: { type: "object" },
      preview_path: { type: "string" },
      review_level: { type: "string", enum: ["static", "browser", "final"], default: "static" },
      browser_preview_checked: { type: "boolean", default: false },
      frame_samples_checked: { type: "boolean", default: false },
      output_path: { type: "string" },
    },
  };
  override artifact_schema = { artifact: "character_qa_report" };
  override side_effects = ["optionally writes character_qa_report JSON to output_path"];

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const start = Date.now();
    const issues: string[] = [];
    const rig = (inputs["rig_plan"] as Record<string, unknown>) ?? {};
    const poses = (inputs["pose_library"] as Record<string, unknown>) ?? {};
    const timeline = (inputs["action_timeline"] as Record<string, unknown>) ?? {};
    const previewPath = inputs["preview_path"] as string | undefined;
    const reviewLevel = (inputs["review_level"] as string) ?? "static";
    const browserPreviewChecked = Boolean(inputs["browser_preview_checked"] ?? false);
    const frameSamplesChecked = Boolean(inputs["frame_samples_checked"] ?? false);

    let assetsExist = true;
    if (!previewPath) {
      assetsExist = false;
      issues.push("Preview path is required for character animation QA.");
    } else if (!fs.existsSync(previewPath)) {
      assetsExist = false;
      issues.push(`Preview path does not exist: ${previewPath}`);
    }

    // `all([])` is True in Python; the `if rig else False` guard makes an empty
    // dict yield False overall. We mirror both: truthy artifact -> all(...),
    // falsy/empty artifact -> false.
    const rigHasContent = isTruthyDict(rig);
    const posesHasContent = isTruthyDict(poses);
    const timelineHasContent = isTruthyDict(timeline);

    const pivotsDefined = rigHasContent
      ? ((rig["characters"] as Array<Record<string, unknown>>) ?? []).every((c) =>
          Boolean(isTruthyDict(c["joints"]))
        )
      : false;
    const posesDefined = posesHasContent
      ? ((poses["characters"] as Array<Record<string, unknown>>) ?? []).every((c) =>
          Boolean(isTruthyDict(c["poses"]))
        )
      : false;
    const actionsTimed = timelineHasContent
      ? ((timeline["scenes"] as Array<Record<string, unknown>>) ?? []).every((s) =>
          Boolean(isTruthyList(s["actions"]))
        )
      : false;

    if (!pivotsDefined) {
      issues.push("Rig plan is missing joints/pivots for one or more characters.");
    }
    if (!posesDefined) {
      issues.push("Pose library is missing poses for one or more characters.");
    }
    if (!actionsTimed) {
      issues.push("Action timeline has scenes without timed actions.");
    }

    let schemaValid = true;
    for (const [artifactName, artifact] of [
      ["rig_plan", rig],
      ["pose_library", poses],
      ["action_timeline", timeline],
    ] as Array<[string, Record<string, unknown>]>) {
      if (!isTruthyDict(artifact)) {
        continue;
      }
      try {
        validateArtifact(artifactName, artifact);
      } catch (exc) {
        schemaValid = false;
        issues.push(`${artifactName} schema validation failed: ${(exc as Error).message ?? exc}`);
      }
    }

    if ((reviewLevel === "browser" || reviewLevel === "final") && !browserPreviewChecked) {
      issues.push("Browser preview check is required for browser/final QA.");
    }
    if (reviewLevel === "final" && !frameSamplesChecked) {
      issues.push("Frame sample check is required for final QA.");
    }

    const status = issues.length === 0 ? "pass" : "revise";
    const report: Record<string, unknown> = {
      version: "1.0",
      status,
      preview_path: previewPath || "",
      checks: {
        schema_valid: schemaValid,
        assets_exist: assetsExist,
        pivots_defined: pivotsDefined,
        poses_defined: posesDefined,
        actions_timed: actionsTimed,
        motion_detected: actionsTimed,
        browser_preview_checked: browserPreviewChecked,
        frame_samples_checked: frameSamplesChecked,
      },
      issues,
      recommended_action: status === "pass" ? "present_to_user" : "fix_rig",
      metadata: {
        source: this.name,
        confidence:
          "static artifact review; run Playwright/FFmpeg checks in compose for final output",
      },
    };
    const artifacts = writeJson(inputs["output_path"] as string | undefined, report);
    return toolResult({
      success: true,
      data: { character_qa_report: report },
      artifacts,
      duration_seconds: round2((Date.now() - start) / 1000),
    });
  }
}

/** Python truthiness for a dict-ish value: non-null object with >=1 own key. */
function isTruthyDict(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return Boolean(value);
}

/** Python truthiness for a list-ish value: non-empty array. */
function isTruthyList(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return isTruthyDict(value);
}
