/**
 * Cost tracker core: estimate, reserve, reconcile, and persist to cost_log.json.
 *
 * TypeScript port of tools/cost_tracker.py. Pure arithmetic/state — NOT a
 * BaseTool subclass, so it is not registered in ALL_TOOLS (Python never
 * discovers it either; it imports BudgetMode from lib.config_model and is a
 * plain class).
 *
 * Implements the budget governance rules from the spec:
 *  - Every paid operation produces a preflight estimate
 *  - The orchestrator reserves estimated budget before execution
 *  - Budget overruns trigger pauses (in warn/cap mode)
 *  - Actual spend is reconciled when the tool finishes or fails
 *
 * Parity notes vs. Python:
 *  - BudgetMode is defined locally to mirror lib.config_model.BudgetMode
 *    (observe/warn/cap) without coupling to another expert's module. Behavior
 *    is identical: OBSERVE skips approval/cap raises; CAP raises on overrun.
 *  - cost_log.json shape ({version, budget_total_usd, budget_reserved_usd,
 *    budget_spent_usd, entries}) and entry fields match verbatim.
 *  - rounding (4 dp) and the estimate_from_reference heuristics are 1:1.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Mirror of lib.config_model.BudgetMode (string enum). */
export enum BudgetMode {
  OBSERVE = "observe",
  WARN = "warn",
  CAP = "cap",
}

/** Mirror of cost_tracker.EntryStatus (string enum). */
export enum EntryStatus {
  ESTIMATED = "estimated",
  RESERVED = "reserved",
  COMPLETED = "completed",
  FAILED = "failed",
  REFUNDED = "refunded",
}

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export class ApprovalRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalRequiredError";
  }
}

export interface CostEntry {
  id: string;
  tool: string;
  operation: string;
  status: string;
  estimated_usd: number;
  reserved_usd: number;
  actual_usd: number;
  timestamp: string;
}

export interface CostTrackerOptions {
  budget_total_usd?: number;
  reserve_pct?: number;
  single_action_approval_usd?: number;
  require_approval_for_new_paid_tool?: boolean;
  mode?: BudgetMode;
  cost_log_path?: string | null;
}

/** Round to 4 decimal places (matches Python round(x, 4)). */
function round4(x: number): number {
  return Math.round((x + Number.EPSILON) * 10000) / 10000;
}

export class CostTracker {
  budget_total_usd: number;
  reserve_pct: number;
  single_action_approval_usd: number;
  require_approval_for_new_paid_tool: boolean;
  mode: BudgetMode;
  cost_log_path: string | null;
  entries: CostEntry[] = [];
  private _approved_tools: Set<string> = new Set();

  constructor(opts: CostTrackerOptions = {}) {
    this.budget_total_usd = opts.budget_total_usd ?? 10.0;
    this.reserve_pct = opts.reserve_pct ?? 0.1;
    this.single_action_approval_usd = opts.single_action_approval_usd ?? 0.5;
    this.require_approval_for_new_paid_tool =
      opts.require_approval_for_new_paid_tool ?? true;
    this.mode = opts.mode ?? BudgetMode.WARN;
    this.cost_log_path = opts.cost_log_path ?? null;

    if (this.cost_log_path && fs.existsSync(this.cost_log_path)) {
      this._load();
    }
  }

  // ---- Budget calculations ----

  get budget_reserved_usd(): number {
    return this.entries
      .filter((e) => e.status === EntryStatus.RESERVED)
      .reduce((sum, e) => sum + (e.reserved_usd ?? 0.0), 0.0);
  }

  get budget_spent_usd(): number {
    return this.entries
      .filter(
        (e) =>
          e.status === EntryStatus.COMPLETED ||
          e.status === EntryStatus.FAILED
      )
      .reduce((sum, e) => sum + (e.actual_usd ?? 0.0), 0.0);
  }

  get budget_remaining_usd(): number {
    return (
      this.budget_total_usd - this.budget_spent_usd - this.budget_reserved_usd
    );
  }

  /** Budget minus the reserve holdback. */
  get usable_budget_usd(): number {
    const holdback = this.budget_total_usd * this.reserve_pct;
    return Math.max(0.0, this.budget_remaining_usd - holdback);
  }

  costSnapshot(): Record<string, number> {
    return {
      total_spent_usd: round4(this.budget_spent_usd),
      total_reserved_usd: round4(this.budget_reserved_usd),
      budget_remaining_usd: round4(this.budget_remaining_usd),
    };
  }

  // ---- Core operations ----

  /** Record an estimate. Returns entry ID. */
  estimate(tool: string, operation: string, estimatedUsd: number): string {
    const entryId = CostTracker._newId();
    this.entries.push({
      id: entryId,
      tool,
      operation,
      status: EntryStatus.ESTIMATED,
      estimated_usd: round4(estimatedUsd),
      reserved_usd: 0.0,
      actual_usd: 0.0,
      timestamp: CostTracker._now(),
    });
    this._save();
    return entryId;
  }

  /**
   * Reserve budget for an estimated entry.
   *
   * Throws BudgetExceededError in cap mode, or ApprovalRequiredError when the
   * action exceeds the single-action approval threshold.
   */
  reserve(entryId: string): void {
    const entry = this._find(entryId);
    const estimated = entry.estimated_usd;

    // Check single-action approval threshold
    if (estimated > this.single_action_approval_usd) {
      if (this.mode !== BudgetMode.OBSERVE) {
        throw new ApprovalRequiredError(
          `Action costs $${estimated.toFixed(2)}, exceeds ` +
            `single-action threshold $${this.single_action_approval_usd.toFixed(
              2
            )}`
        );
      }
    }

    // Check new paid tool approval
    if (this.require_approval_for_new_paid_tool && estimated > 0) {
      if (!this._approved_tools.has(entry.tool)) {
        if (this.mode !== BudgetMode.OBSERVE) {
          throw new ApprovalRequiredError(
            `First paid use of tool '${entry.tool}' requires approval`
          );
        }
      }
    }

    // Check budget
    if (estimated > this.usable_budget_usd) {
      if (this.mode === BudgetMode.CAP) {
        throw new BudgetExceededError(
          `Reservation of $${estimated.toFixed(2)} exceeds usable budget ` +
            `$${this.usable_budget_usd.toFixed(2)}`
        );
      }
    }

    entry.status = EntryStatus.RESERVED;
    entry.reserved_usd = estimated;
    entry.timestamp = CostTracker._now();
    this._save();
  }

  /** Mark a tool as approved for paid operations. */
  approveTool(tool: string): void {
    this._approved_tools.add(tool);
  }

  /** Reconcile actual spend after tool execution. */
  reconcile(entryId: string, actualUsd: number, success = true): void {
    const entry = this._find(entryId);
    entry.status = success ? EntryStatus.COMPLETED : EntryStatus.FAILED;
    entry.actual_usd = round4(actualUsd);
    entry.reserved_usd = 0.0;
    entry.timestamp = CostTracker._now();
    this._save();
  }

  /** Cancel a reservation without executing. */
  refund(entryId: string): void {
    const entry = this._find(entryId);
    entry.status = EntryStatus.REFUNDED;
    entry.reserved_usd = 0.0;
    entry.timestamp = CostTracker._now();
    this._save();
  }

  // ---- Reference-driven estimation ----

  /**
   * Estimate production cost based on reference analysis + target duration.
   * 1:1 port of estimate_from_reference.
   */
  estimateFromReference(
    videoAnalysisBrief: Record<string, any>,
    targetDurationSeconds: number,
    toolPlan: Record<string, any>
  ): Record<string, any> {
    const structure = videoAnalysisBrief.structure_analysis ?? {};
    const pacing = structure.pacing_profile ?? {};
    const narration = videoAnalysisBrief.narration_transcript ?? {};
    const refDuration =
      (videoAnalysisBrief.source ?? {}).duration_seconds ?? 60;
    const pacingStyle = pacing.pacing_style ?? "steady_educational";

    // ── Scene count estimation ──
    const refScenes = structure.total_scenes ?? 8;
    let cutsPerMinute: number;
    if (refDuration > 0) {
      cutsPerMinute = refScenes / (refDuration / 60);
    } else {
      cutsPerMinute = 4.0; // default: moderate pacing
    }

    const minScenesByPacing: Record<string, number> = {
      rapid_fire: 10,
      dynamic_social: 8,
      steady_educational: 5,
      slow_contemplative: 3,
      variable: 6,
    };
    const minScenes = minScenesByPacing[pacingStyle] ?? 5;

    const densityBasedScenes = pyRound(
      cutsPerMinute * (targetDurationSeconds / 60)
    );
    const estimatedScenes = Math.max(minScenes, densityBasedScenes);

    // ── Narration word count ──
    const refWordCount = narration.word_count ?? 0;
    let actualWpm: number;
    if (refDuration > 0 && refWordCount > 0) {
      actualWpm = (refWordCount / refDuration) * 60;
    } else {
      actualWpm = 150; // default conversational pace
    }
    const estimatedWords = pyRound(actualWpm * (targetDurationSeconds / 60));

    // ── Motion ratio from reference ──
    const scenesList: Array<Record<string, any>> = structure.scenes ?? [];
    const [motionRatio, motionBasis] = this._estimateMotionRatio(
      videoAnalysisBrief,
      scenesList,
      pacingStyle
    );

    const estimatedMotionScenes =
      motionRatio > 0 ? Math.max(1, pyRound(estimatedScenes * motionRatio)) : 0;
    // (estimated_still_scenes is computed in Python but unused downstream)

    // ── Video clip coverage ──
    const vidPlan = toolPlan.video_generation ?? {};
    const hasVidPlan = Object.keys(vidPlan).length > 0;
    const clipDuration = hasVidPlan
      ? vidPlan.clip_duration_seconds ?? 5
      : 5;
    const motionSeconds = targetDurationSeconds * motionRatio;
    const clipsNeededForCoverage = hasVidPlan
      ? Math.max(estimatedMotionScenes, pyRound(motionSeconds / clipDuration))
      : 0;

    // ── Retry/waste buffer ──
    const retryMultiplier = 1.3; // ~30% extra for retries and rejected outputs

    // ── Image count ──
    const imagesPerScene =
      pacingStyle === "dynamic_social" || pacingStyle === "rapid_fire"
        ? 2.0
        : 1.5;
    const estimatedImages = Math.max(
      estimatedScenes,
      pyRound(estimatedScenes * imagesPerScene)
    );

    // Build line items
    const lineItems: Array<Record<string, any>> = [];
    const assumptions: string[] = [];

    assumptions.push(
      `${estimatedScenes} scenes (reference has ${cutsPerMinute.toFixed(
        1
      )} cuts/min, pacing: ${pacingStyle})`
    );
    assumptions.push(motionBasis);

    // Image generation
    const imgPlan = toolPlan.image_generation ?? {};
    if (Object.keys(imgPlan).length > 0) {
      const imgCount = pyRound(estimatedImages * retryMultiplier);
      const unitCost = imgPlan.cost_per_unit ?? 0.05;
      lineItems.push({
        category: "image_generation",
        provider: imgPlan.tool ?? "unknown",
        quantity: imgCount,
        unit_cost_usd: unitCost,
        total_usd: round4(imgCount * unitCost),
        basis:
          `~${imagesPerScene.toFixed(0)} images/scene x ${estimatedScenes} scenes ` +
          `+ ${pyRound((retryMultiplier - 1) * 100)}% retry buffer`,
      });
    }

    // Video generation
    if (hasVidPlan && clipsNeededForCoverage > 0) {
      const clipCount = pyRound(clipsNeededForCoverage * retryMultiplier);
      const unitCost = vidPlan.cost_per_unit ?? 0.3;
      lineItems.push({
        category: "video_generation",
        provider: vidPlan.tool ?? "unknown",
        quantity: clipCount,
        unit_cost_usd: unitCost,
        total_usd: round4(clipCount * unitCost),
        basis:
          `${motionSeconds.toFixed(0)}s of motion / ${clipDuration}s clips = ` +
          `${clipsNeededForCoverage} clips + retry buffer`,
      });
      assumptions.push(
        `${pyRound(motionRatio * 100)}% motion ratio -> ` +
          `${motionSeconds.toFixed(0)}s needs ${clipsNeededForCoverage} clips ` +
          `(${clipDuration}s each)`
      );
    }

    // TTS narration
    const ttsPlan = toolPlan.tts ?? {};
    if (Object.keys(ttsPlan).length > 0 && estimatedWords > 10) {
      const costPerWord = ttsPlan.cost_per_word ?? 0.00003;
      const ttsCost = round4(estimatedWords * costPerWord);
      lineItems.push({
        category: "tts_narration",
        provider: ttsPlan.tool ?? "unknown",
        quantity: estimatedWords,
        unit_cost_usd: costPerWord,
        total_usd: ttsCost,
        basis: `Narration at ${pyRound(actualWpm)} WPM = ~${estimatedWords} words`,
      });
      assumptions.push(
        `Narration at ${pyRound(actualWpm)} WPM = ~${estimatedWords} words ` +
          `for ${targetDurationSeconds} seconds`
      );
    }

    // Music
    const musicPlan = toolPlan.music ?? {};
    if (Object.keys(musicPlan).length > 0) {
      const musicCost = musicPlan.cost_per_track ?? 0.0;
      lineItems.push({
        category: "music",
        provider: musicPlan.tool ?? "unknown",
        quantity: 1,
        unit_cost_usd: musicCost,
        total_usd: musicCost,
        basis: "1 background music track",
      });
    }

    const subtotal = round4(
      lineItems.reduce((sum, item) => sum + item.total_usd, 0)
    );

    // ── Cost range instead of single number ──
    const lowTotal = round4(subtotal / retryMultiplier);
    const highTotal = round4(subtotal * 1.15); // 15% above retry-buffered estimate

    // Sample cost: 2 scenes worth of assets (hook + 1 middle)
    const sampleScenes = 2;
    const sampleFraction = sampleScenes / Math.max(estimatedScenes, 1);
    const sampleCost = round4(subtotal * sampleFraction);

    // Confidence based on how much data we have
    let confidence: string;
    if (scenesList.length > 0 && (narration.word_count ?? 0) > 0) {
      confidence = "high";
    } else if (scenesList.length > 0 || (narration.word_count ?? 0) > 0) {
      confidence = "medium";
    } else {
      confidence = "low";
    }

    return {
      line_items: lineItems,
      total_usd: subtotal,
      total_range_usd: { low: lowTotal, high: highTotal },
      sample_cost_usd: sampleCost,
      confidence,
      assumptions,
      estimated_scenes: estimatedScenes,
      estimated_images: estimatedImages,
      estimated_clips: clipsNeededForCoverage,
      estimated_words: estimatedWords,
      motion_ratio: round2(motionRatio),
      cuts_per_minute: round1(cutsPerMinute),
      target_duration_seconds: targetDurationSeconds,
    };
  }

  private _estimateMotionRatio(
    videoAnalysisBrief: Record<string, any>,
    scenesList: Array<Record<string, any>>,
    pacingStyle: string
  ): [number, string] {
    const motionWeights: Record<string, number> = {
      animation: 1.0,
      b_roll: 1.0,
      stock_footage: 1.0,
      product_shot: 0.9,
      transition: 0.6,
      screen_recording: 0.45,
      talking_head: 0.35,
      diagram: 0.25,
      chart: 0.25,
      text_card: 0.2,
    };
    const classifiedWeights: number[] = [];
    for (const scene of scenesList) {
      const visualType = scene.visual_type;
      if (visualType in motionWeights) {
        classifiedWeights.push(motionWeights[visualType]!);
      }
    }
    if (classifiedWeights.length > 0) {
      const classifiedSum = classifiedWeights.reduce((a, b) => a + b, 0);
      let ratio = classifiedSum / classifiedWeights.length;
      const unknownCount = Math.max(
        0,
        scenesList.length - classifiedWeights.length
      );
      let basis: string;
      if (unknownCount) {
        const [fallbackRatio] = this._fallbackMotionRatio(
          videoAnalysisBrief,
          pacingStyle
        );
        ratio =
          (classifiedSum + fallbackRatio * unknownCount) / scenesList.length;
        basis =
          "motion ratio blended from classified scene types and " +
          "reference-style fallback for unclassified scenes";
      } else {
        basis = "motion ratio derived from classified scene types";
      }
      return [round2(Math.min(Math.max(ratio, 0.0), 0.95)), basis];
    }

    return this._fallbackMotionRatio(videoAnalysisBrief, pacingStyle);
  }

  private _fallbackMotionRatio(
    videoAnalysisBrief: Record<string, any>,
    pacingStyle: string
  ): [number, string] {
    const sourceType = (videoAnalysisBrief.source ?? {}).type ?? "";
    const replication = videoAnalysisBrief.replication_guidance ?? {};
    const motionRequired = Boolean(replication.motion_required);
    const suggestedPipeline = replication.suggested_pipeline ?? "";

    const baseByPacing: Record<string, number> = {
      rapid_fire: 0.8,
      dynamic_social: 0.65,
      steady_educational: 0.35,
      slow_contemplative: 0.2,
      variable: 0.5,
    };
    let ratio = baseByPacing[pacingStyle] ?? 0.5;

    if (
      sourceType === "shorts" ||
      sourceType === "instagram" ||
      sourceType === "tiktok"
    ) {
      ratio = Math.max(ratio, 0.7);
    }
    if (motionRequired) {
      ratio = Math.max(ratio, 0.6);
    }
    if (suggestedPipeline === "cinematic") {
      ratio = Math.max(ratio, 0.55);
    }

    ratio = round2(Math.min(Math.max(ratio, 0.1), 0.95));
    const basis =
      "motion ratio inferred from pacing/style because scene visual types " +
      "have not been enriched yet";
    return [ratio, basis];
  }

  // ---- Persistence ----

  private _save(): void {
    if (this.cost_log_path === null) return;
    const data = {
      version: "1.0",
      budget_total_usd: this.budget_total_usd,
      budget_reserved_usd: round4(this.budget_reserved_usd),
      budget_spent_usd: round4(this.budget_spent_usd),
      entries: this.entries,
    };
    fs.mkdirSync(path.dirname(this.cost_log_path), { recursive: true });
    fs.writeFileSync(this.cost_log_path, JSON.stringify(data, null, 2));
  }

  private _load(): void {
    const data = JSON.parse(
      fs.readFileSync(this.cost_log_path as string, "utf-8")
    );
    this.entries = data.entries ?? [];
    this.budget_total_usd = data.budget_total_usd ?? this.budget_total_usd;
  }

  // ---- Helpers ----

  private _find(entryId: string): CostEntry {
    for (const entry of this.entries) {
      if (entry.id === entryId) return entry;
    }
    throw new Error(`Cost entry '${entryId}' not found`);
  }

  private static _newId(): string {
    // uuid4().hex[:12] — strip dashes, take first 12 hex chars.
    return randomUUID().replace(/-/g, "").slice(0, 12);
  }

  private static _now(): string {
    return new Date().toISOString();
  }
}

// ---------------------------------------------------------------------------
// Python round() helpers (banker's rounding for .5 cases).
// estimate_from_reference relies on Python's round() semantics for scene/word
// counts. Python uses round-half-to-even; JS Math.round is round-half-up.
// We replicate the even rounding so integer counts match the Python output.
// ---------------------------------------------------------------------------
function pyRound(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (Math.abs(diff - 0.5) < Number.EPSILON) {
    // Exactly .5 → round to even
    return floor % 2 === 0 ? floor : floor + 1;
  }
  return Math.round(x);
}

function round1(x: number): number {
  return Math.round((x + Number.EPSILON) * 10) / 10;
}

function round2(x: number): number {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}
