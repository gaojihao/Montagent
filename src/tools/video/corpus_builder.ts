/**
 * Corpus builder (TS port of tools/video/corpus_builder.py).
 * Fans out across StockSource adapters → download → frame thumbs → CLIP embed →
 * index into the local Corpus. Per-candidate errors are collected, not fatal.
 *
 * Parity deviations (no-GPU/PyTorch + no-Python rule):
 *  - Frame extraction & dimension/duration probe: cv2.VideoCapture → ffmpeg/ffprobe.
 *  - Motion score (mean-abs gray diff of frame 0 vs middle): cv2/numpy → sharp
 *    (grayscale raw buffers, downscaled to 320px for speed). Relative proxy, same use.
 *  - CLIP embedding: torch/transformers → lib/clip_embedder (transformers.js).
 *  - clip_cache (cross-run hard-link dedup): implemented as a no-op (always miss →
 *    download), so behaviour is correct, just without the optional cache speed-up.
 */
import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
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
import { Corpus, makeClipRecord, type ClipRecord } from "../../lib/corpus.js";
import { getDefaultCache } from "./clip_cache.js";
import { embedImages, embedTexts, poolFrames } from "../../lib/clip_embedder.js";
import {
  type Candidate,
  type SearchFilters,
  type StockSource,
  makeSearchFilters,
  allSources,
  availableSources,
  getSource,
  sourceCatalog,
  sourceSummary,
} from "./stock_sources/index.js";

function guessExt(cand: Candidate): string {
  const known = new Set([".mp4", ".mov", ".mkv", ".webm", ".ogv", ".m4v", ".jpg", ".jpeg", ".png", ".tif", ".tiff"]);
  let ext = "";
  try {
    ext = path.extname(new URL(cand.download_url).pathname).toLowerCase();
  } catch {
    ext = "";
  }
  if (known.has(ext)) return ext === ".jpeg" ? ".jpg" : ext;
  return cand.kind === "video" ? ".mp4" : ".jpg";
}

async function ffprobeVideo(videoPath: string): Promise<{ width: number; height: number; duration: number }> {
  try {
    const { stdout } = await execa(
      "ffprobe",
      ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", videoPath],
      { timeout: 15000, reject: false }
    );
    const probe = JSON.parse(String(stdout ?? "{}")) as { format?: { duration?: string }; streams?: any[] };
    const v = (probe.streams ?? []).find((s) => s.codec_type === "video") ?? {};
    return { width: Number(v.width ?? 0), height: Number(v.height ?? 0), duration: parseFloat(probe.format?.duration ?? "0") || 0 };
  } catch {
    return { width: 0, height: 0, duration: 0 };
  }
}

/** Mean absolute grayscale pixel difference between two jpg frames (downscaled). */
async function motionBetween(frameA: string, frameB: string): Promise<number> {
  try {
    const sharp = (await import("sharp")).default;
    const opts = { width: 320, height: 180, fit: "fill" as const };
    const a = await sharp(frameA).resize(opts).greyscale().raw().toBuffer();
    const b = await sharp(frameB).resize(opts).greyscale().raw().toBuffer();
    const len = Math.min(a.length, b.length);
    let sum = 0;
    for (let i = 0; i < len; i += 1) sum += Math.abs(a[i]! - b[i]!);
    return len > 0 ? sum / len : 0;
  } catch {
    return 0;
  }
}

async function extractVideoThumbs(
  videoPath: string,
  outDir: string,
  nFrames: number
): Promise<{ thumbPaths: string[]; probe: { width: number; height: number; duration: number; motion_score: number } | null }> {
  const probe = await ffprobeVideo(videoPath);
  if (probe.duration <= 0) return { thumbPaths: [], probe: null };
  fs.mkdirSync(outDir, { recursive: true });
  const n = Math.max(1, nFrames);
  const thumbPaths: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = ((i + 0.5) * probe.duration) / n;
    const dst = path.join(outDir, `frame_${String(i).padStart(2, "0")}.jpg`);
    try {
      await execa("ffmpeg", ["-y", "-ss", String(Math.round(t * 100) / 100), "-i", videoPath, "-frames:v", "1", "-q:v", "3", dst], { timeout: 20000, reject: false });
      if (fs.existsSync(dst) && fs.statSync(dst).size > 0) thumbPaths.push(dst);
    } catch {
      /* skip this frame */
    }
  }
  if (thumbPaths.length === 0) return { thumbPaths: [], probe: null };
  let motion = 0;
  if (thumbPaths.length >= 2) motion = await motionBetween(thumbPaths[0]!, thumbPaths[Math.floor(thumbPaths.length / 2)]!);
  return { thumbPaths, probe: { ...probe, motion_score: motion } };
}

async function saveAsJpeg(srcPath: string, dstPath: string): Promise<boolean> {
  try {
    const sharp = (await import("sharp")).default;
    await sharp(srcPath).jpeg({ quality: 88 }).toFile(dstPath);
    return true;
  } catch {
    return false;
  }
}

export class CorpusBuilder extends BaseTool {
  override name = "corpus_builder";
  override version = "0.1.0";
  override tier = ToolTier.SOURCE;
  override capability = "corpus_population";
  override provider = "montagent";
  override stability = ToolStability.EXPERIMENTAL;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;
  override runtime = ToolRuntime.HYBRID;

  override dependencies: string[] = ["cmd:ffmpeg"]; // frames via ffmpeg; CLIP via bundled transformers.js
  override install_instructions =
    "Requires ffmpeg. CLIP embedding runs on CPU via Transformers.js (model downloads on first use).\n" +
    "At least one stock source must be configured:\n  PEXELS_API_KEY for Pexels\n  archive.org works without API keys";
  override agent_skills: string[] = [];

  override capabilities = ["stock_fanout_search", "corpus_population", "clip_indexing", "clip_embedding"];
  override supports = { multi_source: true, video_and_image: true, append_only: true, resumable: true };
  override best_for = [
    "documentary-montage retrieval corpora",
    "topic-based offline clip indexing",
    "collecting candidate B-roll without repeated API calls per edit",
  ];
  override not_good_for = ["single-clip downloads (use pexels_video instead)", "semantic retrieval itself (use clip_search)"];

  override input_schema = {
    type: "object",
    required: ["corpus_dir", "queries"],
    properties: {
      corpus_dir: { type: "string" },
      queries: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string" },
            kind: { type: "string", enum: ["video", "image", "any"], default: "video" },
            per_source: { type: "integer", default: 10, minimum: 1, maximum: 80 },
          },
        },
      },
      sources: { type: "array", items: { type: "string" } },
      filters: {
        type: "object",
        properties: {
          min_duration: { type: "number" },
          max_duration: { type: "number" },
          orientation: { type: "string", enum: ["landscape", "portrait", "square"] },
          min_width: { type: "integer" },
        },
      },
      max_new_clips: { type: "integer", default: 100, minimum: 1 },
      skip_existing: { type: "boolean", default: true },
      thumbs_per_video: { type: "integer", default: 5, minimum: 1, maximum: 20 },
    },
  };

  override resource_profile: ResourceProfile = { cpu_cores: 2, ram_mb: 2048, vram_mb: 0, disk_mb: 4000, network_required: true };
  override side_effects = [
    "downloads clips to <corpus_dir>/clips",
    "writes thumbnails under <corpus_dir>/thumbnails",
    "appends rows to <corpus_dir>/index.jsonl + embedding .npy files",
    "calls external stock APIs",
  ];
  override user_visible_verification = [
    "Open <corpus_dir>/index.jsonl and inspect a few added rows",
    "Open <corpus_dir>/thumbnails/<some_clip_id>/frame_02.jpg visually",
  ];

  override getStatus(): ToolStatus {
    try {
      const total = allSources().length;
      const available = availableSources().length;
      if (available === 0) return ToolStatus.UNAVAILABLE;
      if (available < total) return ToolStatus.DEGRADED;
      return ToolStatus.AVAILABLE;
    } catch {
      return ToolStatus.UNAVAILABLE;
    }
  }

  protected override extraInfo(): Record<string, unknown> {
    try {
      return { source_provider_menu: sourceCatalog(), source_provider_summary: sourceSummary() };
    } catch {
      return {
        source_provider_menu: [],
        source_provider_summary: { configured: 0, total: 0, available_source_names: [], unavailable_source_names: [] },
      };
    }
  }

  override estimateCost(): number {
    return 0;
  }

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const start = Date.now();
    try {
      const corpusDir = inputs.corpus_dir as string;
      const queries = (inputs.queries as Array<Record<string, unknown>>) ?? [];
      const sourceNames = inputs.sources as string[] | undefined;
      const filtersIn = (inputs.filters as Record<string, unknown>) ?? {};
      const maxNew = Number(inputs.max_new_clips ?? 100);
      const skipExisting = (inputs.skip_existing as boolean) ?? true;
      const thumbsPerVideo = Number(inputs.thumbs_per_video ?? 5);

      let sources: StockSource[];
      if (sourceNames && sourceNames.length > 0) {
        sources = [];
        const unavailable: string[] = [];
        const known = new Map(allSources().map((s) => [s.name, s]));
        for (const name of sourceNames) {
          let s = known.get(name);
          if (!s) {
            try {
              s = getSource(name);
            } catch (e) {
              return toolResult({ success: false, error: (e as Error).message });
            }
          }
          if (s.isAvailable()) sources.push(s);
          else unavailable.push(name);
        }
        if (unavailable.length > 0) {
          const summary = sourceSummary() as { available_source_names: string[] };
          return toolResult({
            success: false,
            error: `Requested stock sources are unavailable: ${unavailable.join(", ")}. Available now: ${summary.available_source_names.join(", ") || "none"}.`,
          });
        }
      } else {
        sources = availableSources();
      }
      if (sources.length === 0) return toolResult({ success: false, error: "No stock sources available. " + this.install_instructions });

      const corp = new Corpus(corpusDir);
      corp.load();
      corp.ensureDirs();

      // Shared clip bytes cache (hard-links blobs from previous runs to skip re-downloads).
      const cache = getDefaultCache();
      const runCacheStats = { hits: 0, misses: 0, bytes_saved: 0 };

      const perSourceCounts: Record<string, number> = Object.fromEntries(sources.map((s) => [s.name, 0]));
      const addedIds: string[] = [];
      const errors: Array<Record<string, unknown>> = [];
      let skipped = 0;
      let failed = 0;
      let candidatesSeen = 0;

      const filtersFor = (qSpec: Record<string, unknown>): SearchFilters =>
        makeSearchFilters({
          kind: (qSpec.kind as string) ?? "video",
          per_page: Number(qSpec.per_source ?? 10),
          min_duration: (filtersIn.min_duration as number) ?? null,
          max_duration: (filtersIn.max_duration as number) ?? null,
          orientation: (filtersIn.orientation as string) ?? null,
          min_width: (filtersIn.min_width as number) ?? null,
        });

      for (const qSpec of queries) {
        if (addedIds.length >= maxNew) break;
        const query = qSpec.query as string;
        const f = filtersFor(qSpec);
        for (const src of sources) {
          if (addedIds.length >= maxNew) break;
          let cands: Candidate[];
          try {
            cands = await src.search(query, f);
          } catch (e) {
            errors.push({ phase: "search", source: src.name, query, error: `${(e as Error).name}: ${(e as Error).message}` });
            continue;
          }
          candidatesSeen += cands.length;
          for (const cand of cands) {
            if (addedIds.length >= maxNew) break;
            if (skipExisting && corp.has(cand.clip_id)) {
              skipped += 1;
              continue;
            }
            let rec: ClipRecord | null;
            try {
              rec = await this.processCandidate(cand, src, corp, query, thumbsPerVideo, cache, runCacheStats);
            } catch (e) {
              failed += 1;
              errors.push({ phase: "process", clip_id: cand.clip_id, error: `${(e as Error).name}: ${(e as Error).message}` });
              continue;
            }
            if (rec === null) {
              failed += 1;
              continue;
            }
            addedIds.push(rec.clip_id);
            perSourceCounts[src.name] = (perSourceCounts[src.name] ?? 0) + 1;
          }
        }
      }

      corp.save();
      return toolResult({
        success: true,
        data: {
          corpus_dir: corpusDir,
          queries_run: queries.length,
          candidates_seen: candidatesSeen,
          clips_added: addedIds.length,
          clips_skipped_existing: skipped,
          clips_failed: failed,
          per_source_counts: perSourceCounts,
          added_ids: addedIds,
          total_corpus_size: corp.length,
          requested_sources: sourceNames ?? [],
          resolved_sources: sources.map((s) => s.name),
          source_provider_summary: sourceSummary(),
          cache_hits: runCacheStats.hits,
          cache_misses: runCacheStats.misses,
          cache_bytes_saved: runCacheStats.bytes_saved,
          cache_stats: ((): Record<string, unknown> => {
            try {
              return cache.stats();
            } catch (e) {
              return { error: `${(e as Error).name}: ${(e as Error).message}` };
            }
          })(),
          errors: errors.slice(0, 25),
        },
        cost_usd: 0,
        duration_seconds: Math.round((Date.now() - start) / 10) / 100,
      });
    } catch (e) {
      return toolResult({ success: false, error: `${(e as Error).name}: ${(e as Error).message}` });
    }
  }

  private async processCandidate(
    cand: Candidate,
    src: StockSource,
    corp: Corpus,
    query: string,
    thumbsPerVideo: number,
    cache: ReturnType<typeof getDefaultCache>,
    runCacheStats: { hits: number; misses: number; bytes_saved: number }
  ): Promise<ClipRecord | null> {
    const ext = guessExt(cand);
    const localRel = path.join("clips", `${cand.clip_id}${ext}`);
    const localAbs = path.join(corp.corpusDir, localRel);

    // Try the shared cache first; on a hit it links the blob in and we skip the fetch.
    let cacheHit = false;
    try {
      cacheHit = cache.tryLink(cand.clip_id, localAbs);
    } catch {
      cacheHit = false;
    }
    if (cacheHit) {
      runCacheStats.hits += 1;
      try {
        runCacheStats.bytes_saved += fs.statSync(localAbs).size;
      } catch {
        /* ignore */
      }
    } else {
      runCacheStats.misses += 1;
      await src.download(cand, localAbs);
      if (!fs.existsSync(localAbs) || fs.statSync(localAbs).size < 1024) {
        try {
          if (fs.existsSync(localAbs)) fs.unlinkSync(localAbs);
        } catch {
          /* ignore */
        }
        return null;
      }
      try {
        cache.ingest(cand.clip_id, localAbs, {
          source: cand.source,
          source_id: cand.source_id,
          source_url: cand.source_url,
          license: cand.license,
          creator: cand.creator,
          source_tags: cand.source_tags,
        });
      } catch {
        /* cache faults never block the pipeline */
      }
    }

    const thumbDirRel = path.join("thumbnails", cand.clip_id);
    const thumbDirAbs = path.join(corp.corpusDir, thumbDirRel);
    fs.mkdirSync(thumbDirAbs, { recursive: true });

    let width = cand.width;
    let height = cand.height;
    let duration = cand.duration;
    let motionScore = 0;
    let thumbPaths: string[];

    if (cand.kind === "video") {
      const { thumbPaths: tp, probe } = await extractVideoThumbs(localAbs, thumbDirAbs, thumbsPerVideo);
      if (tp.length === 0) return null;
      thumbPaths = tp;
      if (probe) {
        width = probe.width || width;
        height = probe.height || height;
        duration = probe.duration || duration;
        motionScore = probe.motion_score;
      }
    } else {
      const dst = path.join(thumbDirAbs, "frame_00.jpg");
      if (!(await saveAsJpeg(localAbs, dst))) return null;
      thumbPaths = [dst];
    }

    const clipFrames = await embedImages(thumbPaths);
    const clipVec = poolFrames(clipFrames);
    const tagText = cand.source_tags || query;
    const tagVec = (await embedTexts([tagText]))[0]!;

    const rec = makeClipRecord({
      clip_id: cand.clip_id,
      source: cand.source,
      source_id: cand.source_id,
      source_url: cand.source_url,
      local_path: localRel.split(path.sep).join("/"),
      kind: cand.kind,
      thumb_dir: thumbDirRel.split(path.sep).join("/"),
      query,
      creator: cand.creator,
      license: cand.license,
      duration: duration || 0,
      width: Math.trunc(width || 0),
      height: Math.trunc(height || 0),
      motion_score: motionScore,
      dominant_colors: [],
      source_tags: cand.source_tags,
    });
    corp.add(rec, clipVec, tagVec);
    return rec;
  }
}
