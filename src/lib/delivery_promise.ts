/** Delivery promise classifier (TS port of lib/delivery_promise.py).
 * Classifies what a production promises to deliver; prevents silent motion→still downgrades. */
export enum PromiseType {
  MOTION_LED = "motion_led",
  SOURCE_LED = "source_led",
  DATA_EXPLAINER = "data_explainer",
  TEACHER_EXPLAINER = "teacher_explainer",
  SCREEN_DEMO = "screen_demo",
  AVATAR_PRESENTER = "avatar_presenter",
  HYBRID = "hybrid",
  LOCALIZATION = "localization",
}

export const PROMISE_RULES: Record<string, Record<string, any>> = {
  motion_led: { still_fallback_allowed: false, requires_video_generation: true, min_motion_ratio: 0.7, description: "Video's quality depends on real motion — generated video clips, footage, or animation." },
  source_led: { still_fallback_allowed: true, requires_video_generation: false, min_motion_ratio: 0.3, description: "User-provided footage is the primary medium. Generated assets fill gaps only." },
  data_explainer: { still_fallback_allowed: true, requires_video_generation: false, min_motion_ratio: 0.0, description: "Data visualization and explanation. Motion graphics preferred but images acceptable." },
  teacher_explainer: { still_fallback_allowed: true, requires_video_generation: false, min_motion_ratio: 0.0, description: "Educational content. Clarity and comprehension over spectacle." },
  screen_demo: { still_fallback_allowed: true, requires_video_generation: false, min_motion_ratio: 0.0, description: "Screen recording or product demo. Legibility over cinematic dressing." },
  avatar_presenter: { still_fallback_allowed: false, requires_video_generation: true, min_motion_ratio: 0.3, description: "AI avatar or talking head presentation. Requires video generation for presenter." },
  hybrid: { still_fallback_allowed: true, requires_video_generation: false, min_motion_ratio: 0.2, description: "Mix of source footage, generated content, and graphics." },
  localization: { still_fallback_allowed: true, requires_video_generation: false, min_motion_ratio: 0.0, description: "Translation/dubbing of existing video. Preserving source timing and clarity." },
};

const SLIDE_GRAMMAR_TYPES = new Set(["text_card", "stat_card", "chart", "bar_chart", "line_chart", "pie_chart", "kpi_grid", "comparison", "progress", "callout"]);
const REAL_MOTION_TYPES = new Set(["video", "animation", "avatar"]);

export class DeliveryPromise {
  promise_type: PromiseType;
  motion_required: boolean;
  source_required: boolean;
  tone_mode: string;
  quality_floor: string;
  approved_fallback: string | null;

  constructor(args: { promise_type: PromiseType; motion_required: boolean; source_required: boolean; tone_mode: string; quality_floor: string; approved_fallback?: string | null }) {
    this.promise_type = args.promise_type;
    this.motion_required = args.motion_required;
    this.source_required = args.source_required;
    this.tone_mode = args.tone_mode;
    this.quality_floor = args.quality_floor;
    this.approved_fallback = args.approved_fallback ?? null;
  }

  toDict(): Record<string, any> {
    return { promise_type: this.promise_type, motion_required: this.motion_required, source_required: this.source_required, tone_mode: this.tone_mode, quality_floor: this.quality_floor, approved_fallback: this.approved_fallback };
  }

  static fromDict(data: Record<string, any>): DeliveryPromise {
    return new DeliveryPromise({
      promise_type: data.promise_type as PromiseType,
      motion_required: data.motion_required ?? false,
      source_required: data.source_required ?? false,
      tone_mode: data.tone_mode ?? "corporate",
      quality_floor: data.quality_floor ?? "presentable",
      approved_fallback: data.approved_fallback ?? null,
    });
  }

  getRules(): Record<string, any> {
    return PROMISE_RULES[this.promise_type] ?? {};
  }

  validateCuts(cuts: Array<Record<string, any>>): Record<string, any> {
    const rules = this.getRules();
    const violations: string[] = [];
    if (!cuts || cuts.length === 0) return { valid: false, violations: ["No cuts provided"], motion_ratio: 0.0 };
    let motionCuts = 0, slideCuts = 0, stillCuts = 0;
    for (const cut of cuts) {
      const source = cut.source ?? "";
      const cutType = cut.type ?? "";
      let isMotion = false, isSlide = false;
      if (source) {
        const ext = source.includes(".") ? source.split(".").pop()!.toLowerCase() : "";
        if (["mp4", "mov", "webm", "avi", "mkv"].includes(ext)) isMotion = true;
      }
      if (REAL_MOTION_TYPES.has(cutType)) isMotion = true;
      else if (SLIDE_GRAMMAR_TYPES.has(cutType)) isSlide = true;
      if (isMotion) motionCuts += 1;
      else if (isSlide) slideCuts += 1;
      else stillCuts += 1;
    }
    const total = motionCuts + slideCuts + stillCuts;
    const motionRatio = total > 0 ? motionCuts / total : 0.0;
    const minRatio = rules.min_motion_ratio ?? 0.0;
    if (this.motion_required && motionRatio < minRatio) {
      violations.push(`Motion ratio ${Math.round(motionRatio * 100)}% is below minimum ${Math.round(minRatio * 100)}% for ${this.promise_type}. ${motionCuts}/${total} cuts have real motion (${slideCuts} are animated slides which do not count as motion).`);
    }
    const nonMotion = slideCuts + stillCuts;
    if (!(rules.still_fallback_allowed ?? true) && nonMotion > total * 0.5 && this.approved_fallback !== "still_led") {
      violations.push(`${this.promise_type} does not allow still-led fallback, but ${nonMotion}/${total} cuts are non-motion (stills + animated slides). User must approve 'still_led' fallback or provide motion content.`);
    }
    return { valid: violations.length === 0, violations, motion_ratio: motionRatio, motion_cuts: motionCuts, slide_cuts: slideCuts, still_cuts: stillCuts };
  }
}

export function classifyFromBrief(pipelineType: string, userIntent: Record<string, any>): DeliveryPromise {
  const pipelineDefaults: Record<string, PromiseType> = {
    cinematic: PromiseType.MOTION_LED,
    "animated-explainer": PromiseType.DATA_EXPLAINER,
    animation: PromiseType.MOTION_LED,
    "talking-head": PromiseType.AVATAR_PRESENTER,
    "avatar-spokesperson": PromiseType.AVATAR_PRESENTER,
    "screen-demo": PromiseType.SCREEN_DEMO,
    hybrid: PromiseType.HYBRID,
    "localization-dub": PromiseType.LOCALIZATION,
    "podcast-repurpose": PromiseType.SOURCE_LED,
    "clip-factory": PromiseType.SOURCE_LED,
  };
  let promiseType = pipelineDefaults[pipelineType] ?? PromiseType.HYBRID;
  if (userIntent.motion_required === false && promiseType === PromiseType.MOTION_LED) promiseType = PromiseType.HYBRID;
  const motionRequired = userIntent.motion_required ?? (promiseType === PromiseType.MOTION_LED || promiseType === PromiseType.AVATAR_PRESENTER);
  const sourceRequired = userIntent.has_footage ?? false;
  if (sourceRequired && promiseType !== PromiseType.SOURCE_LED && promiseType !== PromiseType.LOCALIZATION) promiseType = PromiseType.SOURCE_LED;
  return new DeliveryPromise({
    promise_type: promiseType,
    motion_required: motionRequired,
    source_required: sourceRequired,
    tone_mode: userIntent.tone ?? "corporate",
    quality_floor: userIntent.quality ?? "presentable",
  });
}
