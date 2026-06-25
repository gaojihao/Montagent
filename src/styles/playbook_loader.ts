/**
 * Style playbook loader (port of styles/playbook_loader.py).
 *
 * Loads, validates, and lists style playbook YAML files from styles/, plus the
 * design-intelligence helpers (D3.5.5 color palette, D3.5.6 typography, D3.5.7
 * accessibility). All color math is pure and dependency-free, matching Python's
 * use of `colorsys` (ported here as rgbToHls/hlsToRgb).
 *
 * Parity notes vs. Python:
 *  - Validates against schemas/styles/playbook.schema.json via the shared ajv
 *    instance (same schema file as Python's jsonschema).
 *  - Color rounding uses round-half-up to match Python's round() on the .5 cases
 *    that arise here (channel compositing), implemented via Math.round on
 *    positive values (identical for the non-negative inputs used).
 *  - Function names mirror Python snake_case → camelCase.
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import { PROJECT_ROOT } from "../tools/base_tool.js";
import { SCHEMA_ROOT, getValidator, formatErrors } from "../lib/schema_validator.js";

export const STYLES_DIR = path.join(PROJECT_ROOT, "styles");
const SCHEMA_PATH = path.join(SCHEMA_ROOT, "styles", "playbook.schema.json");

export type Playbook = Record<string, any>;

/** Validate a playbook object against the schema. Throws on failure. */
export function validatePlaybook(playbook: unknown): void {
  const validate = getValidator(SCHEMA_PATH);
  if (!validate(playbook)) {
    throw new Error(`Playbook failed schema validation: ${formatErrors(validate)}`);
  }
}

/**
 * Load and validate a style playbook by name.
 *
 * @param name Playbook name (without .yaml extension).
 * @param stylesDir Override directory for playbook files.
 */
export function loadPlaybook(name: string, stylesDir: string = STYLES_DIR): Playbook {
  const filePath = path.join(stylesDir, `${name}.yaml`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Playbook not found: ${filePath}`);
  }
  const playbook = YAML.parse(fs.readFileSync(filePath, "utf-8")) as Playbook;
  validatePlaybook(playbook);
  return playbook;
}

/** List all available playbook names. */
export function listPlaybooks(stylesDir: string = STYLES_DIR): string[] {
  return fs
    .readdirSync(stylesDir)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => f.replace(/\.yaml$/, ""))
    .filter((stem) => stem !== "__pycache__");
}

// ---------------------------------------------------------------------------
// Color math helpers (pure, no external deps)
// ---------------------------------------------------------------------------

function hexToRgb(hexColor: string): [number, number, number] {
  let h = hexColor.replace(/^#/, "");
  if (h.length === 3) {
    h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!;
  }
  if (h.length === 8) {
    h = h.slice(0, 6);
  }
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function hasAlpha(hexColor: string): boolean {
  return hexColor.replace(/^#/, "").length === 8;
}

/**
 * Round-half-to-even (banker's rounding), matching Python's built-in round()
 * for integer rounding. JS Math.round is round-half-up, which diverges on .5
 * boundaries (e.g. round(76.5) → 76 in Python, 77 in JS). Color-channel math
 * here can land exactly on .5, so we replicate Python's behavior for parity.
 */
function pyRound(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  // Exactly .5 → round to even.
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * Python-semantics modulo: the result takes the sign of the divisor (so it is
 * non-negative for a positive `n`). Crucially, when `a` is already in range we
 * return `a % n` directly (no second modulo), which avoids a 1-ULP float drift
 * that an `((a % n) + n) % n` form introduces — keeping hue math bit-for-bit
 * identical to CPython's `%`.
 */
function pyMod(a: number, n: number): number {
  const r = a % n;
  return r < 0 ? r + n : r;
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, pyRound(v)));
  const toHex = (v: number) => clamp(v).toString(16).toUpperCase().padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function compositeAlpha(fgHex: string, bgHex: string): string {
  const h = fgHex.replace(/^#/, "");
  const alpha = parseInt(h.slice(6, 8), 16) / 255.0;
  const fgR = parseInt(h.slice(0, 2), 16);
  const fgG = parseInt(h.slice(2, 4), 16);
  const fgB = parseInt(h.slice(4, 6), 16);
  const [bgR, bgG, bgB] = hexToRgb(bgHex);
  const r = pyRound(alpha * fgR + (1 - alpha) * bgR);
  const g = pyRound(alpha * fgG + (1 - alpha) * bgG);
  const b = pyRound(alpha * fgB + (1 - alpha) * bgB);
  return rgbToHex(r, g, b);
}

function srgbLinearize(c: number): number {
  if (c <= 0.04045) return c / 12.92;
  return Math.pow((c + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hexColor: string): number {
  const [r, g, b] = hexToRgb(hexColor);
  const rLin = srgbLinearize(r / 255.0);
  const gLin = srgbLinearize(g / 255.0);
  const bLin = srgbLinearize(b / 255.0);
  return 0.2126 * rLin + 0.7152 * gLin + 0.0722 * bLin;
}

/** Port of Python colorsys.rgb_to_hls (returns [h, l, s], all 0-1). */
function rgbToHls(r: number, g: number, b: number): [number, number, number] {
  const maxc = Math.max(r, g, b);
  const minc = Math.min(r, g, b);
  const sumc = maxc + minc;
  const rangec = maxc - minc;
  const l = sumc / 2.0;
  if (minc === maxc) return [0.0, l, 0.0];
  const s = l <= 0.5 ? rangec / sumc : rangec / (2.0 - maxc - minc);
  const rc = (maxc - r) / rangec;
  const gc = (maxc - g) / rangec;
  const bc = (maxc - b) / rangec;
  let h: number;
  if (r === maxc) h = bc - gc;
  else if (g === maxc) h = 2.0 + rc - bc;
  else h = 4.0 + gc - rc;
  h = (h / 6.0) % 1.0;
  if (h < 0) h += 1.0; // Python's % yields a non-negative result
  return [h, l, s];
}

/** Port of Python colorsys.hls_to_rgb (inputs 0-1, returns [r, g, b] 0-1). */
function hlsToRgb(h: number, l: number, s: number): [number, number, number] {
  if (s === 0.0) return [l, l, l];
  const m2 = l <= 0.5 ? l * (1.0 + s) : l + s - l * s;
  const m1 = 2.0 * l - m2;
  return [v(m1, m2, h + 1.0 / 3.0), v(m1, m2, h), v(m1, m2, h - 1.0 / 3.0)];
}

function v(m1: number, m2: number, hue: number): number {
  hue = hue % 1.0;
  if (hue < 0) hue += 1.0;
  if (hue < 1.0 / 6.0) return m1 + (m2 - m1) * hue * 6.0;
  if (hue < 0.5) return m2;
  if (hue < 2.0 / 3.0) return m1 + (m2 - m1) * (2.0 / 3.0 - hue) * 6.0;
  return m1;
}

function hexToHsl(hexColor: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hexColor);
  const [h, l, s] = rgbToHls(r / 255.0, g / 255.0, b / 255.0);
  return [h * 360.0, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const hNorm = pyMod(h, 360) / 360.0;
  const [r, g, b] = hlsToRgb(hNorm, l, s);
  return rgbToHex(pyRound(r * 255), pyRound(g * 255), pyRound(b * 255));
}

// ---------------------------------------------------------------------------
// Color-blind simulation confusion pairs
// ---------------------------------------------------------------------------
type HueRange = [number, number];
const CVD_CONFUSION_PAIRS: Record<string, Array<[HueRange, HueRange]>> = {
  deuteranopia: [
    [[0, 30], [90, 150]],
    [[30, 60], [90, 130]],
    [[330, 360], [90, 150]],
  ],
  protanopia: [
    [[0, 40], [80, 140]],
    [[340, 360], [80, 140]],
    [[0, 20], [170, 200]],
  ],
  tritanopia: [
    [[200, 270], [50, 100]],
    [[220, 260], [40, 80]],
    [[170, 210], [300, 340]],
  ],
};

function hueInRange(hue: number, hueRange: HueRange): boolean {
  const [low, high] = hueRange;
  if (low <= high) return low <= hue && hue <= high;
  return hue >= low || hue <= high;
}

// ---------------------------------------------------------------------------
// D3.5.5 — Color palette intelligence
// ---------------------------------------------------------------------------

export interface ContrastResult {
  foreground: string;
  background: string;
  ratio: number;
  normal_text: { AA: boolean; AAA: boolean };
  large_text: { AA: boolean; AAA: boolean };
}

/** Round to 2 decimals (matches Python round(x, 2)). */
function round2(x: number): number {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

/**
 * Stringify a rounded ratio the way Python's f-string renders a float: whole
 * numbers keep a trailing ".0" (e.g. 4.0 → "4.0", not "4"), matching the
 * message text the Python loader produces.
 */
function pyNum(x: number): string {
  return Number.isInteger(x) ? `${x}.0` : String(x);
}

/** Calculate WCAG 2.1 contrast ratio between foreground and background. */
export function validateContrast(fgHex: string, bgHex: string): ContrastResult {
  const l1 = relativeLuminance(fgHex);
  const l2 = relativeLuminance(bgHex);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  const ratio = (lighter + 0.05) / (darker + 0.05);
  return {
    foreground: fgHex,
    background: bgHex,
    ratio: round2(ratio),
    normal_text: { AA: ratio >= 4.5, AAA: ratio >= 7.0 },
    large_text: { AA: ratio >= 3.0, AAA: ratio >= 4.5 },
  };
}

export interface ColorBlindResult {
  safe: boolean;
  colors_analyzed: number;
  issues: Array<{
    type: string;
    color_a: string;
    color_b: string;
    severity: string;
    message: string;
  }>;
}

/** Check a list of colors for color-blind confusion pairs. */
export function checkColorBlindSafety(colors: string[]): ColorBlindResult {
  const hues = colors.map((c) => {
    const [h, s, l] = hexToHsl(c);
    return { hex: c, hue: h, saturation: s, lightness: l };
  });

  const results: ColorBlindResult = {
    safe: true,
    colors_analyzed: colors.length,
    issues: [],
  };

  for (const [cvdType, confusionRanges] of Object.entries(CVD_CONFUSION_PAIRS)) {
    for (let i = 0; i < hues.length; i++) {
      for (let j = i + 1; j < hues.length; j++) {
        const c1 = hues[i]!;
        const c2 = hues[j]!;
        if (c1.saturation < 0.15 || c2.saturation < 0.15) continue;
        if (Math.abs(c1.lightness - c2.lightness) > 0.3) continue;
        for (const [rangeA, rangeB] of confusionRanges) {
          const aInA = hueInRange(c1.hue, rangeA);
          const bInB = hueInRange(c2.hue, rangeB);
          const aInB = hueInRange(c1.hue, rangeB);
          const bInA = hueInRange(c2.hue, rangeA);
          if ((aInA && bInB) || (aInB && bInA)) {
            results.safe = false;
            results.issues.push({
              type: cvdType,
              color_a: c1.hex,
              color_b: c2.hex,
              severity: "warning",
              message: `${c1.hex} and ${c2.hex} may be indistinguishable for ${cvdType} viewers`,
            });
          }
        }
      }
    }
  }

  return results;
}

export interface PaletteIssue {
  pair: string;
  ratio?: number;
  severity: string;
  message: string;
}

/** Run contrast and color-blind checks on all text/bg pairs in a playbook. */
export function validatePalette(playbook: Playbook): PaletteIssue[] {
  const issues: PaletteIssue[] = [];
  const palette = playbook.visual_language?.color_palette ?? {};
  const bg = palette.background ?? "#FFFFFF";
  const text = palette.text ?? "#000000";
  const muted = palette.muted;

  let result = validateContrast(text, bg);
  if (!result.normal_text.AA) {
    issues.push({
      pair: `text (${text}) on background (${bg})`,
      ratio: result.ratio,
      severity: "error",
      message: `Fails WCAG AA for normal text (ratio ${pyNum(result.ratio)}:1, need 4.5:1)`,
    });
  } else if (!result.normal_text.AAA) {
    issues.push({
      pair: `text (${text}) on background (${bg})`,
      ratio: result.ratio,
      severity: "info",
      message: `Passes AA but not AAA for normal text (ratio ${pyNum(result.ratio)}:1)`,
    });
  }

  if (muted) {
    result = validateContrast(muted, bg);
    if (!result.large_text.AA) {
      issues.push({
        pair: `muted (${muted}) on background (${bg})`,
        ratio: result.ratio,
        severity: "error",
        message: `Muted text fails AA even for large text (ratio ${pyNum(result.ratio)}:1)`,
      });
    } else if (!result.normal_text.AA) {
      issues.push({
        pair: `muted (${muted}) on background (${bg})`,
        ratio: result.ratio,
        severity: "warning",
        message: `Muted text fails AA for normal text (ratio ${pyNum(result.ratio)}:1, OK for large)`,
      });
    }
  }

  const overlays = playbook.overlays ?? {};
  for (const [overlayName, overlay] of Object.entries(overlays as Record<string, any>)) {
    let oBg = overlay.bg;
    let oText = overlay.text;
    if (oBg && oText) {
      if (hasAlpha(oBg)) oBg = compositeAlpha(oBg, bg);
      if (hasAlpha(oText)) oText = compositeAlpha(oText, bg);
      result = validateContrast(oText, oBg);
      if (!result.normal_text.AA) {
        issues.push({
          pair: `overlay.${overlayName}: text (${oText}) on bg (${oBg})`,
          ratio: result.ratio,
          severity: "error",
          message: `Overlay '${overlayName}' fails WCAG AA (ratio ${pyNum(result.ratio)}:1)`,
        });
      }
    }
  }

  const allColors: string[] = [];
  for (const c of palette.primary ?? []) allColors.push(c);
  for (const c of palette.accent ?? []) allColors.push(c);
  const chartPalette =
    playbook.visual_language?.color_palette?.chart_palette ?? playbook.chart_palette ?? [];
  for (const c of chartPalette) allColors.push(c);

  if (allColors.length >= 2) {
    const cvdResult = checkColorBlindSafety(allColors);
    for (const cvdIssue of cvdResult.issues) {
      issues.push({
        pair: `${cvdIssue.color_a} / ${cvdIssue.color_b}`,
        severity: "warning",
        message: cvdIssue.message,
      });
    }
  }

  return issues;
}

/** Generate a color harmony palette from a base color. */
export function generateHarmony(baseHex: string, harmonyType: string): string[] {
  const [h, s, l] = hexToHsl(baseHex);
  let offsets: number[];
  if (harmonyType === "complementary") offsets = [0, 180];
  else if (harmonyType === "analogous") offsets = [-30, 0, 30];
  else if (harmonyType === "triadic") offsets = [0, 120, 240];
  else if (harmonyType === "split-complementary") offsets = [0, 150, 210];
  else
    throw new Error(
      `Unknown harmony type: ${JSON.stringify(harmonyType)}. ` +
        `Choose from: complementary, analogous, triadic, split-complementary`,
    );
  return offsets.map((offset) => hslToHex(pyMod(h + offset, 360), s, l));
}

// ---------------------------------------------------------------------------
// D3.5.6 — Typography intelligence
// ---------------------------------------------------------------------------

export const TYPE_SCALE_RATIOS: Record<string, number> = {
  minor_second: 1.067,
  major_second: 1.125,
  minor_third: 1.2,
  major_third: 1.25,
  perfect_fourth: 1.333,
  golden: 1.618,
};

export interface TypeScale {
  ratio_name: string;
  ratio_value: number;
  base_size_px: number;
  sizes: {
    caption: number;
    body: number;
    subheading: number;
    heading: number;
    display: number;
  };
}

/** Generate a modular type scale from a base size and ratio. */
export function computeTypeScale(baseSize: number, ratio: string = "major_third"): TypeScale {
  let r: number;
  if (ratio in TYPE_SCALE_RATIOS) {
    r = TYPE_SCALE_RATIOS[ratio]!;
  } else {
    const parsed = Number(ratio);
    if (Number.isNaN(parsed)) {
      throw new Error(
        `Unknown type scale ratio: ${JSON.stringify(ratio)}. ` +
          `Choose from: ${Object.keys(TYPE_SCALE_RATIOS).join(", ")} or a number.`,
      );
    }
    r = parsed;
  }

  return {
    ratio_name: ratio in TYPE_SCALE_RATIOS ? ratio : "custom",
    ratio_value: Math.round((r + Number.EPSILON) * 10000) / 10000,
    base_size_px: baseSize,
    sizes: {
      caption: Math.round(baseSize / r),
      body: baseSize,
      subheading: Math.round(baseSize * r),
      heading: Math.round(baseSize * r ** 2),
      display: Math.round(baseSize * r ** 3),
    },
  };
}

export interface TypographyIssue {
  roles: string;
  severity: string;
  message: string;
}

/** Validate that typography sizes follow a clear hierarchy. */
export function validateTypeHierarchy(playbook: Playbook): TypographyIssue[] {
  const issues: TypographyIssue[] = [];
  const typography = playbook.typography ?? {};

  const roles = ["headings", "body", "code", "stat_card"];
  const roleWeights: Record<string, number> = {};
  const roleMultipliers: Record<string, number> = {};

  for (const role of roles) {
    const spec = typography[role];
    if (spec) {
      roleWeights[role] = spec.weight ?? 400;
      roleMultipliers[role] = spec.size_multiplier ?? 1.0;
    }
  }

  const headW = roleWeights.headings ?? 700;
  const bodyW = roleWeights.body ?? 400;
  if (headW <= bodyW) {
    issues.push({
      roles: "headings vs body",
      severity: "warning",
      message: `Heading weight (${headW}) should be greater than body weight (${bodyW}) for clear hierarchy`,
    });
  }

  const statMult = roleMultipliers.stat_card ?? 1.0;
  if (statMult <= 1.0) {
    issues.push({
      roles: "stat_card",
      severity: "warning",
      message: `stat_card size_multiplier (${statMult}) should be > 1.0 for visual prominence`,
    });
  }

  if (headW - bodyW < 200) {
    issues.push({
      roles: "headings vs body",
      severity: "info",
      message: `Weight difference between headings (${headW}) and body (${bodyW}) is only ${headW - bodyW}. Consider >= 200 difference for clear visual separation.`,
    });
  }

  const scaleSystem = typography.scale_system;
  if (scaleSystem && scaleSystem in TYPE_SCALE_RATIOS) {
    const ratio = TYPE_SCALE_RATIOS[scaleSystem]!;
    if (ratio < 1.1) {
      issues.push({
        roles: "scale_system",
        severity: "info",
        message: `Scale ratio '${scaleSystem}' (${ratio}) is very tight. Consider a larger ratio for video content.`,
      });
    }
  }

  return issues;
}

export interface FontPairing {
  font: string;
  category: string;
  rationale: string;
}

const FONT_PAIRINGS: Record<string, FontPairing[]> = {
  Inter: [
    { font: "Lora", category: "serif", rationale: "Geometric sans + transitional serif. High x-height match." },
    { font: "Playfair Display", category: "serif", rationale: "Clean sans + high-contrast serif for elegant contrast." },
    { font: "JetBrains Mono", category: "monospace", rationale: "Matched x-height for code blocks alongside Inter body text." },
  ],
  "Space Grotesk": [
    { font: "Space Mono", category: "monospace", rationale: "Same type family. Unified geometric DNA." },
    { font: "DM Serif Display", category: "serif", rationale: "Bold serif headlines with geometric sans body." },
    { font: "Fira Code", category: "monospace", rationale: "Ligature-rich code font pairs well with geometric body text." },
  ],
  "IBM Plex Sans": [
    { font: "IBM Plex Serif", category: "serif", rationale: "Same type family. Perfect metric compatibility." },
    { font: "IBM Plex Mono", category: "monospace", rationale: "Same type family. Unified design language for technical content." },
    { font: "Merriweather", category: "serif", rationale: "Humanist sans + humanist serif. Both optimized for screen readability." },
  ],
  Lora: [
    { font: "Inter", category: "sans-serif", rationale: "Transitional serif + geometric sans. Clean modern pairing." },
    { font: "Source Sans Pro", category: "sans-serif", rationale: "Classic serif + humanist sans. Traditional yet readable." },
  ],
  "Playfair Display": [
    { font: "Source Sans Pro", category: "sans-serif", rationale: "High-contrast display serif + neutral sans-serif body." },
    { font: "Raleway", category: "sans-serif", rationale: "Elegant serif + thin geometric sans for luxury feel." },
  ],
  "JetBrains Mono": [
    { font: "Inter", category: "sans-serif", rationale: "Matched x-height. Both designed for screen readability." },
  ],
  "Fira Code": [
    { font: "Fira Sans", category: "sans-serif", rationale: "Same type family. Unified design language." },
    { font: "Space Grotesk", category: "sans-serif", rationale: "Both geometric with similar proportions." },
  ],
};

const CATEGORY_PAIRINGS: Record<string, FontPairing[]> = {
  sans: [
    { font: "Lora", category: "serif", rationale: "A versatile serif that pairs well with most sans-serif fonts." },
    { font: "Source Serif Pro", category: "serif", rationale: "Neutral serif with excellent readability alongside sans-serif." },
  ],
  serif: [
    { font: "Inter", category: "sans-serif", rationale: "Clean geometric sans-serif that complements most serif fonts." },
    { font: "Source Sans Pro", category: "sans-serif", rationale: "Humanist sans-serif with broad serif compatibility." },
  ],
  mono: [
    { font: "Inter", category: "sans-serif", rationale: "Versatile sans-serif body text alongside monospace code." },
  ],
};

/** Suggest complementary fonts for a given primary font. */
export function suggestFontPairing(primaryFont: string): FontPairing[] {
  if (primaryFont in FONT_PAIRINGS) return FONT_PAIRINGS[primaryFont]!;
  const fontLower = primaryFont.toLowerCase();
  if (fontLower.includes("mono") || fontLower.includes("code")) return CATEGORY_PAIRINGS.mono!;
  if (fontLower.includes("serif") && !fontLower.includes("sans")) return CATEGORY_PAIRINGS.serif!;
  return CATEGORY_PAIRINGS.sans!;
}

// ---------------------------------------------------------------------------
// D3.5.7 — Accessibility validation
// ---------------------------------------------------------------------------

export const MIN_VIDEO_BODY_SIZE_PX = 24;

export interface AccessibilityIssue {
  category: string;
  severity?: string;
  message: string;
  pair?: string;
  ratio?: number;
  roles?: string;
}

export interface AccessibilityResult {
  pass: boolean;
  error_count: number;
  warning_count: number;
  total_issues: number;
  issues: AccessibilityIssue[];
}

/** Comprehensive accessibility validation for a playbook. */
export function validateAccessibility(playbook: Playbook): AccessibilityResult {
  const issues: AccessibilityIssue[] = [];

  const paletteIssues = validatePalette(playbook);
  for (const pi of paletteIssues) {
    issues.push({ category: "ratio" in pi ? "contrast" : "color_blind", ...pi });
  }

  const typography = playbook.typography ?? {};
  const scaleSystem = typography.scale_system;
  if (scaleSystem) {
    const scale = computeTypeScale(MIN_VIDEO_BODY_SIZE_PX, scaleSystem);
    const sizes = scale.sizes;
    if (sizes.caption < 16) {
      issues.push({
        category: "font_size",
        severity: "warning",
        message: `Caption size (${sizes.caption}px) is below 16px. May be unreadable on mobile video.`,
      });
    }
  } else {
    const statMult = typography.stat_card?.size_multiplier ?? 1.0;
    if (statMult < 2.0) {
      issues.push({
        category: "font_size",
        severity: "info",
        message: `stat_card size_multiplier (${statMult}) is modest. Consider >= 2.0x for video stat cards.`,
      });
    }
  }

  const hierarchyIssues = validateTypeHierarchy(playbook);
  for (const hi of hierarchyIssues) {
    issues.push({ category: "typography", ...hi });
  }

  const chartPalette = playbook.chart_palette ?? [];
  if (chartPalette && chartPalette.length >= 2) {
    const cvdResult = checkColorBlindSafety(chartPalette);
    if (!cvdResult.safe) {
      for (const ci of cvdResult.issues) {
        issues.push({ category: "color_blind", severity: "warning", message: ci.message });
      }
    }
  }

  const weightMatrix = typography.weight_matrix ?? {};
  if (Object.keys(weightMatrix).length > 0) {
    const expectedOrder = ["title", "heading", "body", "caption"];
    let prevWeight = 1000;
    for (const role of expectedOrder) {
      const w = weightMatrix[role];
      if (w !== undefined && w !== null && w > prevWeight) {
        issues.push({
          category: "typography",
          severity: "warning",
          message: `Weight matrix: '${role}' weight (${w}) should not exceed the weight of higher-priority roles.`,
        });
      }
      if (w !== undefined && w !== null) prevWeight = w;
    }
  }

  const errorCount = issues.filter((i) => i.severity === "error").length;
  const warningCount = issues.filter((i) => i.severity === "warning").length;

  return {
    pass: errorCount === 0,
    error_count: errorCount,
    warning_count: warningCount,
    total_issues: issues.length,
    issues,
  };
}
