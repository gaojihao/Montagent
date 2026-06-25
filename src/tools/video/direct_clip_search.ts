/**
 * Direct clip search: lightweight provider-agnostic stock footage acquisition
 * (TS port of tools/video/direct_clip_search.py). Fans out across StockSource
 * adapters, downloads clips, extracts ffmpeg thumbnails. No CLIP/embeddings.
 */
import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import {
  BaseTool,
  Determinism,
  ExecutionMode,
  type ResourceProfile,
  type RetryPolicy,
  type ToolResult,
  ToolRuntime,
  ToolStability,
  ToolStatus,
  ToolTier,
  toolResult,
} from "../base_tool.js";
import {
  type Candidate,
  type SearchFilters,
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

async function extractMidThumbnail(videoPath: string, thumbPath: string): Promise<void> {
  fs.mkdirSync(path.dirname(thumbPath), { recursive: true });
  let duration = 0;
  try {
    const { stdout } = await execa("ffprobe", ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", videoPath], { timeout: 10000, reject: false });
    duration = parseFloat(String(stdout ?? "").trim() || "0") || 0;
  } catch {
    duration = 0;
  }
  const seek = duration > 1 ? Math.max(0.5, duration / 2) : 2.0;
  await execa("ffmpeg", ["-y", "-ss", String(Math.round(seek * 100) / 100), "-i", videoPath, "-frames:v", "1", "-q:v", "3", thumbPath], { timeout: 15000, reject: false });
}

export class DirectClipSearch extends BaseTool {
  override name = "direct_clip_search";
  override version = "0.1.0";
  override tier = ToolTier.SOURCE;
  override capability = "clip_acquisition";
  override provider = "montagent";
  override stability = ToolStability.BETA;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;
  override runtime = ToolRuntime.HYBRID;

  override dependencies: string[] = [];
  override install_instructions =
    "At least one stock source must be configured:\n" +
    "  PEXELS_API_KEY for Pexels (free at https://www.pexels.com/api/)\n" +
    "  archive.org works without API keys";
  override agent_skills: string[] = [];

  override capabilities = ["multi_source_search", "clip_download", "thumbnail_extraction"];
  override supports = { multi_source: true, video_and_image: true, provider_agnostic: true, cross_act_reuse: true };
  override best_for = [
    "act-by-act documentary production with manual clip selection",
    "fast B-roll acquisition when you know what you need",
    "downloading clips from multiple providers in one call",
    "building clip libraries without CLIP embedding overhead",
  ];
  override not_good_for = ["semantic similarity ranking (use corpus_builder + clip_search)", "automated slot filling without human review"];
  override fallback_tools = ["corpus_builder", "pexels_video"];

  override input_schema = {
    type: "object",
    required: ["output_dir", "queries"],
    properties: {
      output_dir: { type: "string" },
      queries: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string" },
            slot_id: { type: "string" },
            kind: { type: "string", enum: ["video", "image", "any"], default: "video" },
          },
        },
      },
      sources: { type: "array", items: { type: "string" } },
      clips_per_query: { type: "integer", default: 3, minimum: 1, maximum: 20 },
      filters: {
        type: "object",
        properties: {
          min_duration: { type: "number" },
          max_duration: { type: "number" },
          orientation: { type: "string", enum: ["landscape", "portrait", "square"] },
          min_width: { type: "integer" },
        },
      },
      extract_thumbnails: { type: "boolean", default: true },
      skip_existing: { type: "boolean", default: true },
    },
  };

  override resource_profile: ResourceProfile = { cpu_cores: 1, ram_mb: 512, vram_mb: 0, disk_mb: 2000, network_required: true };
  override retry_policy: RetryPolicy = { max_retries: 1, backoff_seconds: 1.0, retryable_errors: ["timeout", "rate_limit"] };
  override side_effects = ["downloads clips to <output_dir>/clips/", "extracts thumbnails to <output_dir>/thumbnails/", "calls external stock APIs"];
  override user_visible_verification = ["Browse <output_dir>/thumbnails/ to visually verify clip matches", "Play clips from <output_dir>/clips/ to check quality"];

  override getStatus(): ToolStatus {
    try {
      return availableSources().length > 0 ? ToolStatus.AVAILABLE : ToolStatus.UNAVAILABLE;
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
      const outputDir = inputs.output_dir as string;
      const queries = (inputs.queries as Array<Record<string, unknown>>) ?? [];
      const sourceNames = inputs.sources as string[] | undefined;
      const filtersIn = (inputs.filters as Record<string, unknown>) ?? {};
      const clipsPerQuery = Number(inputs.clips_per_query ?? 3);
      const extractThumbs = (inputs.extract_thumbnails as boolean) ?? true;
      const skipExisting = (inputs.skip_existing as boolean) ?? true;

      const clipsDir = path.join(outputDir, "clips");
      const thumbsDir = path.join(outputDir, "thumbnails");
      fs.mkdirSync(clipsDir, { recursive: true });
      if (extractThumbs) fs.mkdirSync(thumbsDir, { recursive: true });

      let sources;
      if (sourceNames && sourceNames.length > 0) {
        sources = [];
        const unavailable: string[] = [];
        const known = new Map(allSources().map((s) => [s.name, s]));
        for (const name of sourceNames) {
          let s = known.get(name);
          if (!s) {
            try {
              s = getSource(name);
            } catch {
              return toolResult({ success: false, error: `Unknown stock source: ${JSON.stringify(name)}. Available: ${allSources().map((x) => x.name).join(", ")}` });
            }
          }
          if (s.isAvailable()) sources.push(s);
          else unavailable.push(name);
        }
        if (unavailable.length > 0) {
          const summary = sourceSummary() as { available_source_names: string[] };
          return toolResult({ success: false, error: `Requested sources unavailable: ${unavailable.join(", ")}. Available: ${summary.available_source_names.join(", ") || "none"}.` });
        }
      } else {
        sources = availableSources();
      }
      if (sources.length === 0) return toolResult({ success: false, error: "No stock sources available. " + this.install_instructions });

      const downloaded: Array<Record<string, unknown>> = [];
      const errors: Array<Record<string, unknown>> = [];
      let skipped = 0;
      const perSourceCounts: Record<string, number> = Object.fromEntries(sources.map((s) => [s.name, 0]));

      for (const qSpec of queries) {
        const query = qSpec.query as string;
        const slotId = (qSpec.slot_id as string) ?? "";
        const kind = (qSpec.kind as string) ?? "video";
        let collected = 0;
        const filters: SearchFilters = makeSearchFilters({
          kind,
          per_page: Math.max(clipsPerQuery * 2, 10),
          min_duration: (filtersIn.min_duration as number) ?? null,
          max_duration: (filtersIn.max_duration as number) ?? null,
          orientation: (filtersIn.orientation as string) ?? null,
          min_width: (filtersIn.min_width as number) ?? null,
        });

        for (const src of sources) {
          if (collected >= clipsPerQuery) break;
          let candidates: Candidate[];
          try {
            candidates = await src.search(query, filters);
          } catch (e) {
            errors.push({ phase: "search", source: src.name, query, error: `${(e as Error).name}: ${(e as Error).message}` });
            continue;
          }
          for (const cand of candidates) {
            if (collected >= clipsPerQuery) break;
            const clipId = cand.clip_id;
            const ext = guessExt(cand);
            const clipPath = path.join(clipsDir, `${clipId}${ext}`);
            const thumbPath = path.join(thumbsDir, `${clipId}.jpg`);

            if (skipExisting && fs.existsSync(clipPath) && fs.statSync(clipPath).size > 1024) {
              skipped += 1;
              downloaded.push({ ...this.candPayload(cand, query, slotId, clipPath), thumbnail: fs.existsSync(thumbPath) ? thumbPath : "", skipped_existing: true });
              collected += 1;
              continue;
            }
            try {
              await src.download(cand, clipPath);
            } catch (e) {
              errors.push({ phase: "download", clip_id: clipId, source: src.name, error: `${(e as Error).name}: ${(e as Error).message}` });
              continue;
            }
            if (!fs.existsSync(clipPath) || fs.statSync(clipPath).size < 1024) {
              errors.push({ phase: "download", clip_id: clipId, source: src.name, error: "Download produced empty or tiny file" });
              try {
                if (fs.existsSync(clipPath)) fs.unlinkSync(clipPath);
              } catch {
                /* ignore */
              }
              continue;
            }
            let thumbStr = "";
            if (extractThumbs && cand.kind === "video") {
              try {
                await extractMidThumbnail(clipPath, thumbPath);
                if (fs.existsSync(thumbPath)) thumbStr = thumbPath;
              } catch {
                /* non-fatal */
              }
            }
            perSourceCounts[src.name] = (perSourceCounts[src.name] ?? 0) + 1;
            collected += 1;
            downloaded.push({ ...this.candPayload(cand, query, slotId, clipPath), thumbnail: thumbStr, skipped_existing: false });
          }
        }
      }

      return toolResult({
        success: true,
        data: {
          output_dir: outputDir,
          clips_downloaded: downloaded.filter((d) => !d.skipped_existing).length,
          clips_reused: skipped,
          total_clips: downloaded.length,
          per_source_counts: perSourceCounts,
          queries_run: queries.length,
          resolved_sources: sources.map((s) => s.name),
          clips: downloaded,
          errors: errors.slice(0, 25),
        },
        cost_usd: 0,
        duration_seconds: Math.round((Date.now() - start) / 10) / 100,
      });
    } catch (e) {
      return toolResult({ success: false, error: `${(e as Error).name}: ${(e as Error).message}` });
    }
  }

  private candPayload(cand: Candidate, query: string, slotId: string, clipPath: string): Record<string, unknown> {
    return {
      clip_id: cand.clip_id,
      source: cand.source,
      source_id: cand.source_id,
      source_url: cand.source_url,
      query,
      slot_id: slotId,
      kind: cand.kind,
      path: clipPath,
      duration: cand.duration,
      width: cand.width,
      height: cand.height,
      creator: cand.creator,
      license: cand.license,
      source_tags: cand.source_tags,
    };
  }
}
