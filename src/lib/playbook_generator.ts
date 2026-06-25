/** Custom playbook generator (TS port of lib/playbook_generator.py).
 * Produces a schema-valid playbook from a production context when no preset fits. */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { PROJECT_ROOT } from "../tools/base_tool.js";
import { getValidator, formatErrors } from "./schema_validator.js";

const STYLES_DIR = path.join(PROJECT_ROOT, "styles");
const CUSTOM_STYLES_DIR = path.join(STYLES_DIR, "custom");
const PLAYBOOK_SCHEMA_PATH = path.join(PROJECT_ROOT, "schemas", "styles", "playbook.schema.json");

export function loadExistingPlaybook(name: string): Record<string, any> {
  let p = path.join(STYLES_DIR, `${name}.yaml`);
  if (!fs.existsSync(p)) p = path.join(CUSTOM_STYLES_DIR, `${name}.yaml`);
  if (!fs.existsSync(p)) throw new Error(`Playbook not found: ${name}`);
  return YAML.parse(fs.readFileSync(p, "utf-8")) as Record<string, any>;
}

export function listPlaybooks(): string[] {
  const names = new Set<string>();
  for (const dir of [STYLES_DIR, CUSTOM_STYLES_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) if (f.endsWith(".yaml")) names.add(f.replace(/\.yaml$/, ""));
  }
  return [...names].sort();
}

export function generatePlaybook(name: string, context: Record<string, any>, basePlaybook?: string | null): Record<string, any> {
  const playbook = basePlaybook ? loadExistingPlaybook(basePlaybook) : createMinimalPlaybook(name, context);
  playbook.identity = playbook.identity ?? {};
  playbook.identity.name = name;
  if (context.mood) playbook.identity.mood = context.mood;
  if (context.pace) playbook.identity.pace = context.pace;
  if (context.tone) {
    const toneToCategory: Record<string, string> = { cinematic: "cinematic", educational: "minimalist", corporate: "motion-graphics", playful: "motion-graphics", raw: "cinematic" };
    playbook.identity.category = toneToCategory[context.tone] ?? "custom";
  }
  if (context.colors) {
    const colors = context.colors;
    const cp = playbook.visual_language.color_palette;
    if (colors.primary) cp.primary = typeof colors.primary === "string" ? [colors.primary] : colors.primary;
    if (colors.accent) cp.accent = typeof colors.accent === "string" ? [colors.accent] : colors.accent;
    if (colors.background) cp.background = colors.background;
    if (colors.text) cp.text = colors.text;
  }
  if (context.fonts) {
    if (context.fonts.headings) playbook.typography.headings.font = context.fonts.headings;
    if (context.fonts.body) playbook.typography.body.font = context.fonts.body;
  }
  return playbook;
}

function createMinimalPlaybook(name: string, context: Record<string, any>): Record<string, any> {
  const mood = context.mood ?? "professional";
  const tone = context.tone ?? "corporate";
  let bg: string, text: string, primary: string[], accent: string[];
  if (["dark", "cinematic", "dramatic"].includes(mood)) { bg = "#0F172A"; text = "#F8FAFC"; primary = ["#3B82F6"]; accent = ["#F59E0B"]; }
  else if (["warm", "intimate", "organic"].includes(mood)) { bg = "#FFFBEB"; text = "#1C1917"; primary = ["#D97706"]; accent = ["#059669"]; }
  else if (["playful", "energetic", "bold"].includes(mood)) { bg = "#FFFFFF"; text = "#1F2937"; primary = ["#7C3AED"]; accent = ["#EC4899"]; }
  else { bg = "#FFFFFF"; text = "#1F2937"; primary = ["#2563EB"]; accent = ["#F59E0B"]; }
  return {
    identity: { name, category: "custom", mood, pace: context.pace ?? "moderate", best_for: `Custom playbook for ${tone} ${mood} content` },
    visual_language: { color_palette: { primary, accent, background: bg, text }, composition: "balanced grid with breathing room", texture: "clean digital" },
    typography: { headings: { font: "Inter", weight: 700 }, body: { font: "Inter", weight: 400 } },
    motion: {
      transitions: ["crossfade", "cut"],
      animation_style: "spring-based with moderate damping",
      pacing_rules: { min_scene_hold_seconds: 2.0, max_scene_hold_seconds: 6.0, text_card_hold_seconds: 3.5, stat_card_hold_seconds: 4.0, transition_duration_seconds: 0.4 },
    },
    audio: { voice_style: "clear, conversational, authoritative", music_mood: mood, music_volume: 0.15 },
    asset_generation: { image_prompt_prefix: `${mood} ${tone} style`, consistency_anchors: [`${mood} color palette`, `${tone} visual language`] },
    quality_rules: ["Maintain color consistency across all scenes", "Text must be legible on all backgrounds", "Transitions should be purposeful, not decorative"],
    chart_palette: [...primary, ...accent, "#10B981", "#EF4444", "#8B5CF6"],
  };
}

export function savePlaybook(playbook: Record<string, any>, projectName?: string | null): string {
  const validate = getValidator(PLAYBOOK_SCHEMA_PATH);
  if (!validate(playbook)) throw new Error(`Playbook failed schema validation:\n${formatErrors(validate)}`);
  const name = projectName || playbook.identity.name;
  const filename = String(name).toLowerCase().replace(/ /g, "-").replace(/_/g, "-");
  fs.mkdirSync(CUSTOM_STYLES_DIR, { recursive: true });
  const p = path.join(CUSTOM_STYLES_DIR, `${filename}.yaml`);
  fs.writeFileSync(p, YAML.stringify(playbook), "utf-8");
  return p;
}
