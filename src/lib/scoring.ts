/**
 * Provider and production path scoring engine.
 *
 * TypeScript port of lib/scoring.py.
 *
 * Replaces naive "first available provider" selection with weighted
 * multi-dimensional scoring. Every provider choice should be explainable —
 * not just "it was available."
 *
 * Scores are normalized 0-1. Higher is better.
 *
 * Parity notes vs. Python:
 *  - ProviderScore is a class (the Python dataclass). Field names stay
 *    snake_case so toDict() output matches the Python JSON verbatim, and
 *    toDict() appends "weighted_score" after the dataclass fields (asdict order).
 *  - weightedScore is a getter (the Python @property weighted_score).
 *  - explain() float formatting matches Python f"{v:.2f}" / f"(w={weight})"
 *    via Number.prototype.toFixed; the top-3 sort is stable (ES2019+), matching
 *    Python's stable sorted().
 *  - rankProviders sorts best-first; the sort is stable, matching Python.
 *  - normalizeTaskContext returns a NEW object (dict(task_context or {})), and
 *    sorted() over a set is reproduced with .sort() over a deduped array.
 *  - score_provider / rank_providers operate on BaseTool instances via
 *    getInfo()/getStatus()/estimateCost() (camelCase methods in the TS port).
 */
import type { BaseTool } from "../tools/base_tool.js";

// ---------------------------------------------------------------------------
// Provider Score
// ---------------------------------------------------------------------------

/** Scored evaluation of a provider against a specific task context. */
export class ProviderScore {
  tool_name: string;
  provider: string;
  task_fit: number; // 0-1: best fit for this exact asset class
  output_quality: number; // 0-1: expected fidelity for the brief
  control: number; // 0-1: reference/style directability
  reliability: number; // 0-1: runtime confidence
  cost_efficiency: number; // 0-1: quality per dollar
  latency: number; // 0-1: acceptable turnaround
  continuity: number; // 0-1: fits already locked decisions

  constructor(args: {
    tool_name: string;
    provider: string;
    task_fit?: number;
    output_quality?: number;
    control?: number;
    reliability?: number;
    cost_efficiency?: number;
    latency?: number;
    continuity?: number;
  }) {
    this.tool_name = args.tool_name;
    this.provider = args.provider;
    this.task_fit = args.task_fit ?? 0.0;
    this.output_quality = args.output_quality ?? 0.0;
    this.control = args.control ?? 0.0;
    this.reliability = args.reliability ?? 0.0;
    this.cost_efficiency = args.cost_efficiency ?? 0.0;
    this.latency = args.latency ?? 0.0;
    this.continuity = args.continuity ?? 0.0;
  }

  get weighted_score(): number {
    return (
      this.task_fit * 0.3 +
      this.output_quality * 0.2 +
      this.control * 0.15 +
      this.reliability * 0.15 +
      this.cost_efficiency * 0.1 +
      this.latency * 0.05 +
      this.continuity * 0.05
    );
  }

  toDict(): Record<string, number | string> {
    return {
      tool_name: this.tool_name,
      provider: this.provider,
      task_fit: this.task_fit,
      output_quality: this.output_quality,
      control: this.control,
      reliability: this.reliability,
      cost_efficiency: this.cost_efficiency,
      latency: this.latency,
      continuity: this.continuity,
      weighted_score: this.weighted_score,
    };
  }

  /** Human-readable explanation of this score. */
  explain(): string {
    const parts = [
      `${this.tool_name} (${this.provider}): ${this.weighted_score.toFixed(2)}`,
    ];
    const top: Array<[string, number, number]> = [
      ["task_fit", this.task_fit, 0.3],
      ["output_quality", this.output_quality, 0.2],
      ["control", this.control, 0.15],
      ["reliability", this.reliability, 0.15],
      ["cost_efficiency", this.cost_efficiency, 0.1],
      ["latency", this.latency, 0.05],
      ["continuity", this.continuity, 0.05],
    ];
    // sorted(..., key=lambda x: x[1] * x[2], reverse=True) — stable.
    const sorted = stableSortDesc(top, (x) => x[1] * x[2]);
    for (const [name, val, weight] of sorted.slice(0, 3)) {
      parts.push(`  ${name}=${val.toFixed(2)} (w=${formatWeight(weight)})`);
    }
    return parts.join("\n");
  }
}

// ---------------------------------------------------------------------------
// Production Path Score
// ---------------------------------------------------------------------------

/** Scored evaluation of an entire production path. */
export class ProductionPathScore {
  path_label: string;
  delivery_fit: number;
  quality_fit: number;
  capability_confidence: number;
  fallback_integrity: number;
  budget_fit: number;
  speed_fit: number;
  controllability: number;
  consistency_fit: number;

  constructor(args: {
    path_label: string;
    delivery_fit?: number;
    quality_fit?: number;
    capability_confidence?: number;
    fallback_integrity?: number;
    budget_fit?: number;
    speed_fit?: number;
    controllability?: number;
    consistency_fit?: number;
  }) {
    this.path_label = args.path_label;
    this.delivery_fit = args.delivery_fit ?? 0.0;
    this.quality_fit = args.quality_fit ?? 0.0;
    this.capability_confidence = args.capability_confidence ?? 0.0;
    this.fallback_integrity = args.fallback_integrity ?? 0.0;
    this.budget_fit = args.budget_fit ?? 0.0;
    this.speed_fit = args.speed_fit ?? 0.0;
    this.controllability = args.controllability ?? 0.0;
    this.consistency_fit = args.consistency_fit ?? 0.0;
  }

  get weighted_score(): number {
    return (
      this.delivery_fit * 0.25 +
      this.quality_fit * 0.2 +
      this.capability_confidence * 0.15 +
      this.fallback_integrity * 0.1 +
      this.budget_fit * 0.1 +
      this.speed_fit * 0.08 +
      this.controllability * 0.07 +
      this.consistency_fit * 0.05
    );
  }

  toDict(): Record<string, number | string> {
    return {
      path_label: this.path_label,
      delivery_fit: this.delivery_fit,
      quality_fit: this.quality_fit,
      capability_confidence: this.capability_confidence,
      fallback_integrity: this.fallback_integrity,
      budget_fit: this.budget_fit,
      speed_fit: this.speed_fit,
      controllability: this.controllability,
      consistency_fit: this.consistency_fit,
      weighted_score: this.weighted_score,
    };
  }
}

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

/** Stable descending sort by a numeric key (mirrors Python sorted(reverse=True)). */
function stableSortDesc<T>(items: T[], key: (item: T) => number): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const ka = key(a.item);
      const kb = key(b.item);
      if (ka < kb) return 1;
      if (ka > kb) return -1;
      return a.index - b.index; // stable
    })
    .map((wrapped) => wrapped.item);
}

/**
 * Render a weight the way Python's f"(w={weight})" does: trailing-zero-free
 * (0.3 not "0.30", 0.05 not "0.0500"). Mirrors Python float repr for these
 * fixed literals (0.3, 0.2, 0.15, 0.1, 0.05).
 */
function formatWeight(weight: number): string {
  return String(weight);
}

/**
 * Overlap coefficient between two keyword sets.
 *
 * Uses |A ∩ B| / min(|A|, |B|) rather than Jaccard. Jaccard over-penalizes
 * tools whose best_for describes many strengths — a premium provider with
 * seven rich bullets ends up with a smaller Jaccard than a narrowly-scoped
 * provider with one bullet, even when the premium provider fully covers the
 * intent. Overlap coefficient answers the relevant question: "is the intent
 * a subset of what this tool advertises?" which is what we actually care
 * about for provider scoring.
 */
function keywordOverlap(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 || setB.size === 0) {
    return 0.0;
  }
  const a = new Set([...setA].map((s) => s.toLowerCase().trim()));
  const b = new Set([...setB].map((s) => s.toLowerCase().trim()));
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection += 1;
  }
  const smaller = Math.min(a.size, b.size);
  return smaller > 0 ? intersection / smaller : 0.0;
}

// Semantic synonym clusters: when intent says "cinematic" and tool says
// "film" or "movie", that's a match even without literal keyword overlap.
const SYNONYM_CLUSTERS: Array<Set<string>> = [
  new Set(["cinematic", "film", "movie", "trailer", "dramatic", "epic"]),
  new Set(["explainer", "educational", "tutorial", "teaching", "lesson"]),
  new Set(["corporate", "business", "professional", "enterprise"]),
  new Set(["social", "tiktok", "instagram", "reels", "shorts", "viral"]),
  new Set(["animation", "animated", "motion-graphics", "motion", "kinetic"]),
  new Set(["pixar", "animation", "animated", "stylized", "storybook", "character"]),
  new Set(["realistic", "photorealistic", "lifelike", "natural"]),
  new Set(["stock", "footage", "b-roll", "library"]),
  new Set(["avatar", "presenter", "talking-head", "spokesperson"]),
  new Set(["voiceover", "narration", "speech", "voice"]),
  new Set(["music", "soundtrack", "background-music", "score", "ambient"]),
];

// Python: re.compile(r"[a-z0-9][a-z0-9+._-]*") — global match over lowercased text.
const TOKEN_RE = /[a-z0-9][a-z0-9+._-]*/g;

const GENERATED_VISUAL_TERMS = new Set([
  "animated",
  "animation",
  "anime",
  "cartoon",
  "character",
  "cinematic",
  "concept",
  "fantasy",
  "ghibli",
  "illustration",
  "pixar",
  "render",
  "scifi",
  "short",
  "story",
  "stylized",
  "surreal",
]);
const REFERENCE_TERMS = new Set([
  "character",
  "consistency",
  "identity",
  "preserve",
  "product",
  "reference",
  "subject",
  "wardrobe",
]);
const IMAGE_EDIT_TERMS = new Set([
  "combine",
  "composite",
  "edit",
  "merge",
  "modify",
  "repaint",
  "replace",
  "style-transfer",
  "transfer",
]);

function tokenizeText(value: string): string[] {
  return (value || "").toLowerCase().match(TOKEN_RE) ?? [];
}

/** Expand a word set with synonyms from known clusters. */
function expandSynonyms(words: Set<string>): Set<string> {
  const expanded = new Set(words);
  for (const cluster of SYNONYM_CLUSTERS) {
    let intersects = false;
    for (const w of expanded) {
      if (cluster.has(w)) {
        intersects = true;
        break;
      }
    }
    if (intersects) {
      for (const c of cluster) expanded.add(c);
    }
  }
  return expanded;
}

/**
 * Score how well a tool's best_for matches the task intent and style.
 *
 * Uses synonym expansion and a real tokenizer so that semantic near-misses
 * (e.g. "cinematic" vs "film") and punctuation-adjacent tokens (e.g.
 * "trailers," vs "trailer") still score well, not just literal whitespace
 * splits.
 */
function computeTaskFit(
  bestFor: Set<string>,
  intent: string,
  styleKeywords: Set<string>
): number {
  if (bestFor.size === 0) {
    return 0.3; // Unknown capability — modest default
  }

  const intentWords = expandSynonyms(new Set(tokenizeText(intent)));
  let bestForWords = new Set<string>();
  for (const desc of bestFor) {
    for (const tok of tokenizeText(desc)) bestForWords.add(tok);
  }
  bestForWords = expandSynonyms(bestForWords);

  const intentScore = keywordOverlap(intentWords, bestForWords);

  const styleExpanded = expandSynonyms(
    new Set([...styleKeywords].map((kw) => kw.toLowerCase()))
  );
  const styleScore = keywordOverlap(styleExpanded, bestForWords);

  return Math.min(1.0, intentScore * 0.7 + styleScore * 0.3 + 0.1);
}

/**
 * Score controllability from the supports dict.
 *
 * Features are weighted by creative impact — controlnet and reference_image
 * are worth more than seed or aspect_ratio.
 */
function computeControl(supports: Record<string, unknown>): number {
  // (feature_name, weight) — higher weight = more creative control
  const controlFeatures: Array<[string, number]> = [
    ["controlnet", 2.0],
    ["reference_image", 1.8],
    ["style_transfer", 1.5],
    ["inpainting", 1.5],
    ["img2img", 1.3],
    ["negative_prompt", 1.0],
    ["custom_size", 0.8],
    ["aspect_ratio", 0.7],
    ["seed", 0.5],
  ];
  if (!supports || Object.keys(supports).length === 0) {
    return 0.3;
  }
  let totalWeight = 0.0;
  for (const [, w] of controlFeatures) totalWeight += w;
  let earned = 0.0;
  for (const [f, w] of controlFeatures) {
    if (supports[f]) earned += w;
  }
  return Math.min(1.0, earned / (totalWeight * 0.5));
}

/** Score cost efficiency. Free is 1.0, over-budget is 0.0. */
function computeCostEfficiency(
  estimatedCost: number,
  budgetRemaining: number | null | undefined
): number {
  if (estimatedCost <= 0) {
    return 1.0;
  }
  if (budgetRemaining !== null && budgetRemaining !== undefined && budgetRemaining <= 0) {
    return 0.0;
  }
  if (budgetRemaining !== null && budgetRemaining !== undefined) {
    const ratio = estimatedCost / budgetRemaining;
    if (ratio > 0.5) {
      return 0.1;
    }
    if (ratio > 0.2) {
      return 0.5;
    }
    return 0.8;
  }
  // No budget info — use absolute cost heuristic
  if (estimatedCost < 0.05) {
    return 0.9;
  }
  if (estimatedCost < 0.2) {
    return 0.7;
  }
  if (estimatedCost < 1.0) {
    return 0.5;
  }
  return 0.3;
}

/** Score how well this provider fits already-locked decisions. */
function computeContinuity(provider: string, lockedProviders: Set<string>): number {
  if (lockedProviders.size === 0) {
    return 0.5; // No prior context
  }
  if (lockedProviders.has(provider)) {
    return 0.9; // Same provider = likely consistent style
  }
  return 0.4; // Different provider = possible style break
}

/** Normalize loose task context into the scorer's expected shape. */
export function normalizeTaskContext(
  taskContext: Record<string, unknown> | null | undefined,
  options: { prompt?: string; capability?: string; operation?: string } = {}
): Record<string, unknown> {
  const prompt = options.prompt ?? "";
  const capability = options.capability ?? "";
  const operation = options.operation ?? "";

  const context: Record<string, unknown> = { ...(taskContext ?? {}) };

  let needs: unknown = context["needs"] || [];
  if (typeof needs === "string") {
    needs = [needs];
  }
  const needsArr: unknown[] = Array.isArray(needs) ? needs : [];

  const textFragments: string[] = [];
  for (const key of ["intent", "style", "brief", "goal", "platform"]) {
    const value = context[key];
    if (typeof value === "string" && value.trim()) {
      textFragments.push(value.trim());
    }
  }
  for (const item of needsArr) {
    const s = String(item).trim();
    if (s) textFragments.push(s);
  }
  if (prompt.trim()) {
    textFragments.push(prompt.trim());
  }

  const combinedText = textFragments.join(" ").trim();
  if (!context["intent"]) {
    context["intent"] = combinedText;
  }

  const styleKeywords = new Set<string>();
  const rawStyleKeywords = context["style_keywords"];
  if (Array.isArray(rawStyleKeywords)) {
    for (const item of rawStyleKeywords) {
      const s = String(item).toLowerCase().trim();
      if (s) styleKeywords.add(s);
    }
  }
  for (const source of [context["style"], context["platform"], ...needsArr]) {
    if (typeof source === "string") {
      for (const tok of tokenizeText(source)) styleKeywords.add(tok);
    }
  }
  context["style_keywords"] = [...styleKeywords].sort(cmpStr);

  if (!context["asset_type"]) {
    const assetTypeMap: Record<string, string> = {
      video_generation: "video",
      image_generation: "image",
      tts: "voice",
      music_generation: "music",
    };
    if (capability in assetTypeMap) {
      context["asset_type"] = assetTypeMap[capability];
    }
  }

  if (!("motion_required" in context) && capability === "video_generation") {
    context["motion_required"] = true;
  }

  if (
    !("budget_remaining_usd" in context) &&
    context["budget_usd"] !== null &&
    context["budget_usd"] !== undefined
  ) {
    context["budget_remaining_usd"] = context["budget_usd"];
  }

  const textTokens = new Set(tokenizeText(combinedText));
  context["prefers_generated_visuals"] = setsIntersect(textTokens, GENERATED_VISUAL_TERMS);
  context["wants_reference_conditioning"] =
    operation === "reference_to_video" || setsIntersect(textTokens, REFERENCE_TERMS);
  context["wants_image_editing"] =
    operation === "edit" || setsIntersect(textTokens, IMAGE_EDIT_TERMS);

  return context;
}

function setsIntersect(a: Set<string>, b: Set<string>): boolean {
  for (const item of a) {
    if (b.has(item)) return true;
  }
  return false;
}

/** Codepoint-order string comparison (mirrors Python's sorted() on strings). */
function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isStockLikeProvider(info: Record<string, unknown>): boolean {
  const provider = String(info["provider"] ?? "").toLowerCase();
  if (provider === "pexels" || provider === "pixabay") {
    return true;
  }

  const words = new Set<string>();
  const bestFor = (info["best_for"] as unknown[]) ?? [];
  for (const desc of bestFor) {
    for (const tok of tokenizeText(String(desc))) words.add(tok);
  }
  return setsIntersect(words, new Set(["stock", "footage", "b-roll", "library"]));
}

/**
 * Score a provider against a task context.
 *
 * task_context keys: intent, style_keywords, budget_remaining_usd,
 * locked_providers, motion_required, asset_type.
 */
export function scoreProvider(
  tool: BaseTool,
  taskContext: Record<string, unknown>
): ProviderScore {
  taskContext = normalizeTaskContext(taskContext);
  const info = tool.getInfo();
  // .value on the ToolStatus enum returns "available" / "degraded" / "unavailable".
  // The TS string enums already carry the lowercase value, so getStatus() returns it directly.
  const status = tool.getStatus() as string;

  const bestFor = new Set<string>(((info["best_for"] as string[]) ?? []).map(String));
  const intent = (taskContext["intent"] as string) ?? "";
  const styleKeywords = new Set<string>(
    ((taskContext["style_keywords"] as string[]) ?? []).map(String)
  );

  let taskFit = computeTaskFit(bestFor, intent, styleKeywords);

  // Reliability: uses historical success rate if available, else availability status.
  const histSuccess = info["historical_success_rate"]; // 0.0-1.0 if tracked
  let reliability: number;
  if (histSuccess !== null && histSuccess !== undefined) {
    reliability = Number(histSuccess);
  } else if (status === "available") {
    // Stable tools get higher baseline than experimental ones
    reliability = info["stability"] === "production" ? 0.95 : 0.8;
  } else if (status === "degraded") {
    reliability = 0.4;
  } else {
    reliability = 0.0;
  }

  // Control: from supports dict
  let control = computeControl((info["supports"] as Record<string, unknown>) ?? {});

  // Cost efficiency
  let estimatedCost: number;
  try {
    estimatedCost = tool.estimateCost(taskContext);
  } catch {
    estimatedCost = 0.0;
  }
  const costEfficiency = computeCostEfficiency(
    estimatedCost,
    taskContext["budget_remaining_usd"] as number | null | undefined
  );

  // Latency: uses measured p50 latency if available, else runtime class heuristic.
  const measuredP50 = info["latency_p50_seconds"]; // historical median
  let latency: number;
  if (measuredP50 !== null && measuredP50 !== undefined) {
    const p50 = Number(measuredP50);
    // Map measured latency to a 0-1 score (sub-second is best, >60s is worst)
    if (p50 <= 1.0) {
      latency = 1.0;
    } else if (p50 <= 10.0) {
      latency = 0.8;
    } else if (p50 <= 30.0) {
      latency = 0.6;
    } else if (p50 <= 60.0) {
      latency = 0.4;
    } else {
      latency = 0.2;
    }
  } else {
    const runtime = (info["runtime"] as string) ?? "api";
    if (runtime === "local" || runtime === "local_gpu") {
      latency = 0.9;
    } else if (runtime === "hybrid") {
      latency = 0.6;
    } else {
      latency = 0.4;
    }
  }

  // Continuity
  const continuity = computeContinuity(
    (info["provider"] as string) ?? "",
    new Set<string>(((taskContext["locked_providers"] as string[]) ?? []).map(String))
  );

  // Output quality: uses measured quality score if available (e.g. from
  // user ratings or automated eval), else falls back to stability + tier.
  const measuredQuality = info["quality_score"]; // 0.0-1.0 if tracked
  let outputQuality: number;
  if (measuredQuality !== null && measuredQuality !== undefined) {
    outputQuality = Number(measuredQuality);
  } else {
    const stability = (info["stability"] as string) ?? "experimental";
    const tier = (info["tier"] as string) ?? "";
    const qualityMap: Record<string, number> = {
      production: 0.9,
      beta: 0.7,
      experimental: 0.4,
    };
    outputQuality = qualityMap[stability] ?? 0.5;
    // Tier bonus: generate-tier tools that are production-stable get a nudge
    if (tier === "generate" && stability === "production") {
      outputQuality = Math.min(1.0, outputQuality + 0.05);
    }
  }

  // Motion-required penalty: if task needs motion but tool is image-only
  if (taskContext["motion_required"] && taskContext["asset_type"] === "video") {
    const cap = (info["capability"] as string) ?? "";
    if (!cap.includes("video")) {
      taskFit *= 0.2; // Heavy penalty
    }
  }

  const supports = (info["supports"] as Record<string, unknown>) ?? {};
  const stockLike = isStockLikeProvider(info);
  const assetType = taskContext["asset_type"];

  if (
    taskContext["prefers_generated_visuals"] &&
    stockLike &&
    (assetType === "video" || assetType === "image")
  ) {
    taskFit *= 0.55;
    outputQuality *= 0.85;
  }

  if (taskContext["wants_reference_conditioning"] && assetType === "video") {
    if (
      supports["reference_to_video"] ||
      supports["reference_image"] ||
      supports["multiple_reference_images"]
    ) {
      taskFit = Math.min(1.0, taskFit + 0.18);
      control = Math.min(1.0, control + 0.12);
    } else {
      taskFit *= 0.7;
    }
  }

  if (taskContext["wants_image_editing"] && assetType === "image") {
    if (
      supports["image_edit"] ||
      supports["style_transfer"] ||
      supports["multiple_reference_images"]
    ) {
      taskFit = Math.min(1.0, taskFit + 0.18);
      control = Math.min(1.0, control + 0.1);
    } else {
      taskFit *= 0.7;
    }
  }

  // Premium-cinematic bonus: when a video task has cinematic/trailer intent,
  // reward providers that ship the premium feature set — native synchronized
  // audio, multi-shot single-generation, director-level camera control,
  // lip-sync from quoted dialogue. This is what makes Seedance 2.0 (and
  // peer premium APIs) meaningfully better than generic clip providers.
  if (assetType === "video") {
    const intentWords = new Set<string>([
      ...expandSynonyms(new Set(intent.toLowerCase().split(" "))),
      ...styleKeywords,
    ]);
    const cinematicSignal = setsIntersect(
      intentWords,
      new Set([
        "cinematic",
        "film",
        "movie",
        "trailer",
        "teaser",
        "dramatic",
        "epic",
        "premium",
      ])
    );
    if (cinematicSignal) {
      const premiumFeatures = [
        supports["native_audio"],
        supports["multi_shot"],
        supports["camera_direction"],
        supports["lip_sync"],
        supports["cinematic_quality"],
      ];
      let matched = 0;
      for (const f of premiumFeatures) {
        if (f) matched += 1;
      }
      if (matched >= 3) {
        taskFit = Math.min(1.0, taskFit + 0.15);
        outputQuality = Math.min(1.0, outputQuality + 0.1);
      } else if (matched >= 1) {
        taskFit = Math.min(1.0, taskFit + 0.05);
      }
    }
  }

  return new ProviderScore({
    tool_name: (info["name"] as string) ?? "unknown",
    provider: (info["provider"] as string) ?? "unknown",
    task_fit: Math.min(1.0, taskFit),
    output_quality: outputQuality,
    control: control,
    reliability: reliability,
    cost_efficiency: costEfficiency,
    latency: latency,
    continuity: continuity,
  });
}

/**
 * Rank a list of tools by weighted score for a given task context.
 *
 * Returns scores sorted best-first (stable, matching Python sorted()).
 */
export function rankProviders(
  tools: BaseTool[],
  taskContext: Record<string, unknown>
): ProviderScore[] {
  const scores = tools.map((t) => scoreProvider(t, taskContext));
  return stableSortDesc(scores, (s) => s.weighted_score);
}

/** Format a ranking list for user presentation. */
export function formatRanking(rankings: ProviderScore[], topN = 5): string {
  const lines: string[] = [];
  rankings.slice(0, topN).forEach((r, i) => {
    lines.push(
      `  ${i + 1}. ${r.tool_name} (${r.provider}) — ` +
        `score: ${r.weighted_score.toFixed(2)} ` +
        `[fit=${r.task_fit.toFixed(1)} quality=${r.output_quality.toFixed(1)} ` +
        `control=${r.control.toFixed(1)} reliable=${r.reliability.toFixed(1)} ` +
        `cost=${r.cost_efficiency.toFixed(1)}]`
    );
  });
  return lines.join("\n");
}
