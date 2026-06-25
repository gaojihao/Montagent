/** Slideshow risk scorer (TS port of lib/slideshow_risk.py). Scores 6 dimensions (0-5, lower better)
 * predicting whether output feels like a slideshow rather than directed video. */
type DimScore = { score: number; reason: string };

const sl = (s: Record<string, any>) => (s.shot_language ?? {}) as Record<string, any>;
const pct = (n: number, d: number) => `${Math.round((n / d) * 100)}%`;

function counter<T>(items: T[]): Map<T, number> {
  const m = new Map<T, number>();
  for (const it of items) m.set(it, (m.get(it) ?? 0) + 1);
  return m;
}
function mostCommon<T>(items: T[]): [T, number] {
  const m = counter(items);
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0]!;
}

export function scoreSlideshowRisk(
  scenes: Array<Record<string, any>>,
  _editDecisions?: Record<string, any> | null,
  rendererFamily?: string | null,
  renderRuntime?: string | null
): Record<string, any> {
  if (!scenes || scenes.length === 0) return { average: 5.0, verdict: "fail", dimensions: {}, render_runtime: renderRuntime ?? null };
  const dimensions: Record<string, DimScore> = {
    repetition: scoreRepetition(scenes),
    decorative_visuals: scoreDecorative(scenes),
    weak_motion: scoreWeakMotion(scenes),
    weak_shot_intent: scoreWeakIntent(scenes),
    typography_overreliance: scoreTypography(scenes),
    unsupported_cinematic_claims: scoreCinematicClaims(scenes, rendererFamily ?? null),
  };
  const scores = Object.values(dimensions).map((d) => d.score);
  const average = scores.reduce((a, b) => a + b, 0) / scores.length;
  const verdict = average < 2.0 ? "strong" : average < 3.0 ? "acceptable" : average < 4.0 ? "revise" : "fail";
  return { average: Math.round(average * 100) / 100, verdict, dimensions, render_runtime: renderRuntime ?? null };
}

function scoreRepetition(scenes: Array<Record<string, any>>): DimScore {
  if (scenes.length < 3) return { score: 0.0, reason: "Too few scenes to assess repetition" };
  const [mostType, mostCount] = mostCommon(scenes.map((s) => s.type ?? "unknown"));
  const typeRatio = mostCount / scenes.length;
  const descriptions = scenes.map((s) => String(s.description ?? "").toLowerCase().slice(0, 50));
  const uniqueDescRatio = new Set(descriptions).size / descriptions.length;
  const sizeRatio = mostCommon(scenes.map((s) => sl(s).shot_size ?? "none"))[1] / scenes.length;
  let score = 0.0;
  const reasons: string[] = [];
  if (typeRatio > 0.7) { score += 2.0; reasons.push(`Scene type '${mostType}' dominates at ${pct(mostCount, scenes.length)}`); }
  if (uniqueDescRatio < 0.6) { score += 1.5; reasons.push(`Only ${Math.round(uniqueDescRatio * 100)}% unique descriptions`); }
  if (sizeRatio > 0.6) { score += 1.5; reasons.push(`Same shot size in ${Math.round(sizeRatio * 100)}% of scenes`); }
  return { score: Math.min(5.0, score), reason: reasons.join("; ") || "Good variety" };
}

function scoreDecorative(scenes: Array<Record<string, any>>): DimScore {
  let decorative = 0;
  for (const s of scenes) if (!s.information_role && !s.narrative_role && !s.shot_intent) decorative += 1;
  const ratio = decorative / scenes.length;
  const score = Math.min(5.0, ratio * 5.0);
  const reason = ratio > 0.5 ? `${decorative}/${scenes.length} scenes have no stated purpose (no information_role, narrative_role, or shot_intent)` : ratio > 0.2 ? `${decorative}/${scenes.length} scenes lack stated purpose` : "Most scenes have clear communicative purpose";
  return { score: Math.round(score * 10) / 10, reason };
}

function scoreWeakMotion(scenes: Array<Record<string, any>>): DimScore {
  let totalMoving = 0, purposeless = 0;
  for (const s of scenes) {
    const movement = sl(s).camera_movement ?? "static";
    if (movement !== "static" && movement !== "unspecified" && movement != null) {
      totalMoving += 1;
      if (!s.shot_intent) purposeless += 1;
    }
  }
  if (totalMoving === 0) return { score: 1.5, reason: "No camera movement defined (may be intentional for static style)" };
  const ratio = purposeless / totalMoving;
  return { score: Math.round(Math.min(5.0, ratio * 4.0) * 10) / 10, reason: ratio > 0.5 ? `${purposeless}/${totalMoving} moving shots lack shot_intent` : "Camera movement appears purposeful" };
}

function scoreWeakIntent(scenes: Array<Record<string, any>>): DimScore {
  const withIntent = scenes.filter((s) => s.shot_intent).length;
  const ratio = withIntent / scenes.length;
  const score = Math.min(5.0, (1.0 - ratio) * 5.0);
  const reason = ratio < 0.3 ? `Only ${withIntent}/${scenes.length} scenes have shot_intent — most shots lack purpose` : ratio < 0.6 ? `${withIntent}/${scenes.length} scenes have shot_intent` : "Strong shot intent coverage";
  return { score: Math.round(score * 10) / 10, reason };
}

function scoreTypography(scenes: Array<Record<string, any>>): DimScore {
  const textScenes = scenes.filter((s) => ["text_card", "stat_card", "kpi_grid"].includes(s.type)).length;
  const ratio = textScenes / scenes.length;
  if (ratio > 0.6) return { score: 4.0, reason: `${textScenes}/${scenes.length} scenes are text/stat cards — video feels like animated slides` };
  if (ratio > 0.4) return { score: 2.5, reason: `${textScenes}/${scenes.length} scenes are text-based — consider balancing with visual scenes` };
  if (ratio > 0.2) return { score: 1.0, reason: "Balanced text and visual content" };
  return { score: 0.0, reason: "Visual-first approach" };
}

function scoreCinematicClaims(scenes: Array<Record<string, any>>, rendererFamily: string | null): DimScore {
  const isCinematic = rendererFamily && rendererFamily.toLowerCase().includes("cinematic");
  if (!isCinematic) return { score: 0.0, reason: "Not claiming cinematic treatment" };
  const issues: string[] = [];
  if (scenes.filter((s) => s.hero_moment).length === 0) issues.push("Claims cinematic but has no hero_moment defined");
  const hasMovement = scenes.filter((s) => (sl(s).camera_movement ?? "static") !== "static").length;
  if (hasMovement < scenes.length * 0.3) issues.push(`Claims cinematic but only ${hasMovement}/${scenes.length} scenes have camera movement`);
  const hasLighting = scenes.filter((s) => sl(s).lighting_key).length;
  if (hasLighting < scenes.length * 0.3) issues.push(`Claims cinematic but only ${hasLighting}/${scenes.length} scenes define lighting`);
  return { score: Math.round(Math.min(5.0, issues.length * 1.8) * 10) / 10, reason: issues.join("; ") || "Cinematic claims supported by structure" };
}
