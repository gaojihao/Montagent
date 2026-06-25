/** Scene plan variation checker (TS port of lib/variation_checker.py).
 * Structural check that flags repetitive patterns that make videos feel like slideshows. */
const GENERIC_PHRASES = new Set([
  "a person", "a beautiful", "modern", "futuristic", "cutting-edge", "in today's world", "sleek design",
  "innovative", "state-of-the-art", "next-generation", "revolutionary", "a professional", "dynamic",
  "vibrant", "stunning", "breathtaking", "amazing", "incredible", "powerful", "seamless", "elegant solution",
]);

interface VariationResult {
  score: number;
  verdict: "strong" | "acceptable" | "revise" | "fail";
  violations: string[];
  suggestions: string[];
}

const pct = (n: number, d: number) => `${Math.round((n / d) * 100)}%`;
const sl = (s: Record<string, any>) => (s.shot_language ?? {}) as Record<string, any>;

export function checkSceneVariation(scenes: Array<Record<string, any>>): VariationResult {
  if (!scenes || scenes.length === 0) {
    return { score: 5.0, verdict: "fail", violations: ["No scenes to check"], suggestions: [] };
  }
  const violations: string[] = [];
  const suggestions: string[] = [];
  const n = scenes.length;

  // 1: shot size variety
  const shotSizes = scenes.map((s) => sl(s).shot_size ?? "unspecified");
  const sizeCounts = new Map<string, number>();
  for (const sz of shotSizes) sizeCounts.set(sz, (sizeCounts.get(sz) ?? 0) + 1);
  if (n >= 4) {
    const [mostSize, mostCount] = [...sizeCounts.entries()].sort((a, b) => b[1] - a[1])[0]!;
    if (mostCount / n > 0.5) {
      violations.push(`Shot size '${mostSize}' used in ${mostCount}/${n} scenes (${pct(mostCount, n)}). Vary shot sizes for visual interest.`);
      suggestions.push("Mix wide establishing shots with close-ups for visual rhythm.");
    }
  }
  // 2: consecutive same size
  let consecutive = 0;
  for (let i = 1; i < shotSizes.length; i += 1) if (shotSizes[i] === shotSizes[i - 1] && shotSizes[i] !== "unspecified") consecutive += 1;
  if (consecutive >= 3) violations.push(`${consecutive} consecutive same-size shots. Vary shot sizes between scenes for editorial rhythm.`);
  // 3: static overuse
  const movements = scenes.map((s) => sl(s).camera_movement ?? "unspecified");
  const staticCount = movements.filter((m) => m === "static" || m === "unspecified").length;
  if (n >= 4 && staticCount / n > 0.6) {
    violations.push(`${staticCount}/${n} scenes are static or unspecified movement. Add intentional camera movement to at least 40% of scenes.`);
    suggestions.push("Consider dolly_in for emphasis, tracking for energy, or crane for scale.");
  }
  // 4: lighting variety
  const lightings = new Set(scenes.map((s) => sl(s).lighting_key).filter(Boolean));
  if (n >= 4 && lightings.size <= 1) violations.push(`Only ${lightings.size} unique lighting setup(s) across ${n} scenes. Vary lighting to create mood shifts.`);
  // 5: hero moment
  const heroScenes = scenes.filter((s) => s.hero_moment);
  if (n >= 4 && heroScenes.length === 0) {
    violations.push("No hero_moment flagged. Every video should have at least one visual peak.");
    suggestions.push("Mark the most impactful scene as hero_moment=true.");
  }
  for (const hero of heroScenes) {
    const idx = scenes.indexOf(hero);
    const heroSize = sl(hero).shot_size;
    for (const offset of [-1, 1]) {
      const ni = idx + offset;
      if (ni >= 0 && ni < n) {
        const neighborSize = sl(scenes[ni]!).shot_size;
        if (heroSize && neighborSize && heroSize === neighborSize) {
          violations.push(`Hero scene '${hero.id}' has same shot size as neighbor. Hero moments should be visually distinct from surrounding scenes.`);
        }
      }
    }
  }
  // 6: description specificity
  let genericCount = 0;
  for (const scene of scenes) {
    const desc = String(scene.description ?? "").toLowerCase();
    for (const phrase of GENERIC_PHRASES) if (desc.includes(phrase)) { genericCount += 1; break; }
  }
  if (genericCount >= n * 0.3) {
    violations.push(`${genericCount}/${n} scenes use generic language. Replace vague descriptions with specific visual details.`);
    suggestions.push("Instead of 'a beautiful cityscape', try 'rain-slicked Tokyo intersection at night, neon reflections in puddles, pedestrians with translucent umbrellas'.");
  }
  // 7: texture keywords
  const textured = scenes.filter((s) => s.texture_keywords).length;
  if (n >= 4 && textured < n * 0.3) violations.push(`Only ${textured}/${n} scenes have texture_keywords. Add texture descriptors to visual scenes for richer generation prompts.`);
  // 8: shot intent completeness
  const intented = scenes.filter((s) => s.shot_intent).length;
  if (n >= 4 && intented < n * 0.5) violations.push(`Only ${intented}/${n} scenes have shot_intent. Every scene should explain WHY it exists in the video.`);

  const score = Math.min(5.0, violations.length * 0.6);
  const verdict = score < 2.0 ? "strong" : score < 3.0 ? "acceptable" : score < 4.0 ? "revise" : "fail";
  return { score: Math.round(score * 10) / 10, verdict, violations, suggestions };
}
