/**
 * Clip search: unified retrieval over a local clip corpus (TS port of
 * tools/video/clip_search.py). Loads a corpus built by corpus_builder and exposes
 * rank_for_slot / find_similar_set / diversify / get / stats. CLIP text embedding
 * via lib/clip_embedder (transformers.js); all vector math in lib/corpus.
 */
import {
  BaseTool,
  Determinism,
  ExecutionMode,
  type ResourceProfile,
  type ToolResult,
  ToolRuntime,
  ToolStability,
  ToolStatus,
  ToolTier,
  toolResult,
} from "../base_tool.js";
import { Corpus, type ClipRecord } from "../../lib/corpus.js";
import { embedTexts } from "../../lib/clip_embedder.js";

export class ClipSearch extends BaseTool {
  override name = "clip_search";
  override version = "0.1.0";
  override tier = ToolTier.ANALYZE;
  override capability = "clip_retrieval";
  override provider = "montagent";
  override stability = ToolStability.EXPERIMENTAL;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;
  override runtime = ToolRuntime.LOCAL;

  override dependencies: string[] = []; // CLIP runs via bundled transformers.js (ONNX/CPU)
  override install_instructions =
    "Clip embedding runs on CPU via Transformers.js (@xenova/transformers); the CLIP " +
    "model downloads on first use. Requires a corpus built by corpus_builder at <corpus_dir>.";
  override agent_skills: string[] = [];

  override capabilities = ["text_to_clip_ranking", "visual_knn", "mmr_diversification", "provenance_lookup"];
  override supports = { fused_visual_tag_scoring: true, motion_filter: true, kind_filter: true, exclude_list: true };
  override best_for = [
    "picking clips for a specific slot in a montage",
    "finding collection-style sets from one seed clip",
    "de-duplicating a candidate list before edit arrangement",
  ];
  override not_good_for = [
    "searching the internet (use corpus_builder to populate first)",
    "editing or composing video (use video_compose)",
  ];

  override input_schema = {
    type: "object",
    required: ["operation", "corpus_dir"],
    properties: {
      operation: { type: "string", enum: ["rank_for_slot", "find_similar_set", "diversify", "get", "stats"] },
      corpus_dir: { type: "string", description: "Path to the corpus built by corpus_builder." },
      query_text: { type: "string" },
      k: { type: "integer", default: 10, minimum: 1 },
      tag_weight: { type: "number", default: 0.3, minimum: 0, maximum: 1 },
      motion_min: { type: "number" },
      kind: { type: "string", enum: ["video", "image"] },
      exclude_ids: { type: "array", items: { type: "string" } },
      seed_clip_id: { type: "string" },
      n: { type: "integer", default: 5, minimum: 1 },
      diversity: { type: "number", default: 0.3, minimum: 0, maximum: 1 },
      candidate_pool: { type: "integer", default: 30 },
      candidate_ids: { type: "array", items: { type: "string" } },
      clip_id: { type: "string" },
    },
  };

  override resource_profile: ResourceProfile = {
    cpu_cores: 1,
    ram_mb: 1024,
    vram_mb: 0,
    disk_mb: 50,
    network_required: false,
  };
  override side_effects = [];
  override user_visible_verification = [
    "Inspect returned clip_ids and visit thumb_dir/frame_02.jpg to verify the retrieval matches the slot description.",
  ];

  override getStatus(): ToolStatus {
    return ToolStatus.AVAILABLE; // embedder/corpus are bundled; model fetched lazily
  }

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const start = Date.now();
    try {
      const operation = inputs.operation as string;
      const corpusDir = inputs.corpus_dir as string;
      const corp = new Corpus(corpusDir);
      corp.load();

      let payload: Record<string, unknown>;
      if (operation === "stats") payload = this.opStats(corp);
      else if (operation === "rank_for_slot") payload = await this.opRankForSlot(corp, inputs);
      else if (operation === "find_similar_set") payload = this.opFindSimilarSet(corp, inputs);
      else if (operation === "diversify") payload = this.opDiversify(corp, inputs);
      else if (operation === "get") payload = this.opGet(corp, inputs);
      else return toolResult({ success: false, error: `Unknown operation: '${operation}'` });

      return toolResult({
        success: true,
        data: { operation, corpus_dir: corpusDir, corpus_size: corp.length, ...payload },
        duration_seconds: Math.round((Date.now() - start) / 10) / 100,
        cost_usd: 0,
      });
    } catch (e) {
      return toolResult({ success: false, error: `${(e as Error).name}: ${(e as Error).message}` });
    }
  }

  private opStats(corp: Corpus): Record<string, unknown> {
    if (corp.length === 0) {
      return { rows: 0, per_source: {}, per_kind: {}, mean_motion_score: 0, mean_duration: 0 };
    }
    const perSource: Record<string, number> = {};
    const perKind: Record<string, number> = {};
    let motionSum = 0;
    let durSum = 0;
    for (const rec of corp.records) {
      perSource[rec.source] = (perSource[rec.source] ?? 0) + 1;
      perKind[rec.kind] = (perKind[rec.kind] ?? 0) + 1;
      motionSum += rec.motion_score;
      durSum += rec.duration;
    }
    return {
      rows: corp.length,
      per_source: perSource,
      per_kind: perKind,
      mean_motion_score: motionSum / corp.length,
      mean_duration: durSum / corp.length,
    };
  }

  private async opRankForSlot(corp: Corpus, inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
    const queryText = ((inputs.query_text as string) ?? "").trim();
    if (!queryText) throw new Error("rank_for_slot requires 'query_text'");
    const qVec = (await embedTexts([queryText]))[0]!;
    const results = corp.rankByText(qVec, {
      k: Number(inputs.k ?? 10),
      tagWeight: Number(inputs.tag_weight ?? 0.3),
      motionMin: inputs.motion_min !== undefined ? Number(inputs.motion_min) : null,
      kind: (inputs.kind as string) ?? null,
      excludeIds: (inputs.exclude_ids as string[]) ?? [],
    });
    return { query_text: queryText, results: results.map(([rec, score]) => ({ score, record: rec })) };
  }

  private opFindSimilarSet(corp: Corpus, inputs: Record<string, unknown>): Record<string, unknown> {
    const seed = inputs.seed_clip_id as string;
    if (!seed) throw new Error("find_similar_set requires 'seed_clip_id'");
    const results = corp.findSimilarSet(seed, {
      n: Number(inputs.n ?? 5),
      diversity: Number(inputs.diversity ?? 0.3),
      candidatePool: Number(inputs.candidate_pool ?? 30),
      excludeIds: (inputs.exclude_ids as string[]) ?? [],
    });
    return { seed_clip_id: seed, results: results.map(([rec, score]) => ({ score, record: rec })) };
  }

  private opDiversify(corp: Corpus, inputs: Record<string, unknown>): Record<string, unknown> {
    const candidateIds = (inputs.candidate_ids as string[]) ?? [];
    if (candidateIds.length === 0) throw new Error("diversify requires 'candidate_ids'");
    const kept = corp.diversify(candidateIds, Number(inputs.n ?? 5), Number(inputs.diversity ?? 0.5));
    return { input_count: candidateIds.length, kept_count: kept.length, kept_ids: kept };
  }

  private opGet(corp: Corpus, inputs: Record<string, unknown>): Record<string, unknown> {
    const clipId = inputs.clip_id as string;
    if (!clipId) throw new Error("get requires 'clip_id'");
    const rec: ClipRecord | null = corp.get(clipId);
    if (!rec) return { clip_id: clipId, found: false, record: null };
    return { clip_id: clipId, found: true, record: rec };
  }
}
