/** Coverr stock video adapter (TS port of stock_sources/coverr.py). Keyless free tier. */
import { Candidate, type SearchFilters, type StockSource, streamDownload } from "./base.js";

const SEARCH_URL = "https://api.coverr.co/videos";
const LICENSE = "Coverr License (free for commercial and personal use, no attribution required)";

export class CoverrSource implements StockSource {
  readonly name = "coverr";
  static readonly display_name = "Coverr";
  static readonly provider = "coverr";
  static readonly priority = 16;
  static readonly install_instructions = "Coverr works without an API key (free tier, 50 req/hr). Set COVERR_API_KEY in .env for higher rate limits (Pro tier).";
  static readonly supports = { video: true, image: false };

  isAvailable(): boolean {
    return true;
  }

  async search(query: string, filters: SearchFilters): Promise<Candidate[]> {
    if ((filters.kind || "video").toLowerCase() === "image") return [];
    const headers: Record<string, string> = {};
    if (process.env.COVERR_API_KEY) headers.Authorization = `Bearer ${process.env.COVERR_API_KEY}`;
    const params = new URLSearchParams({
      query,
      page_size: String(Math.max(1, Math.min(filters.per_page, 25))),
      page: String(Math.max(1, filters.page)),
    });
    const r = await fetch(`${SEARCH_URL}?${params}`, { headers });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
    const data = (await r.json()) as { hits?: any[]; videos?: any[] };
    const hits = data.hits ?? data.videos ?? [];
    const out: Candidate[] = [];
    for (const v of hits) {
      const duration = Number(v.duration ?? 0) || 0;
      if (filters.min_duration != null && duration < filters.min_duration) continue;
      if (filters.max_duration != null && duration > filters.max_duration) continue;
      const urls = v.urls ?? {};
      const downloadUrl = urls.mp4_download || urls.mp4_1080 || urls.mp4_720 || urls.mp4_preview || "";
      if (!downloadUrl) continue;
      const width = Number(v.width ?? 1920);
      const height = Number(v.height ?? 1080);
      if (filters.min_width && width < filters.min_width) continue;
      let tags = v.tags ?? "";
      if (Array.isArray(tags)) tags = tags.join(" ");
      const sourceTags = `${v.title ?? ""} ${tags}`.trim();
      out.push(
        new Candidate({
          source: this.name,
          source_id: String(v.id ?? v.slug ?? ""),
          source_url: v.url ?? `https://coverr.co/videos/${v.slug ?? ""}`,
          download_url: downloadUrl,
          kind: "video",
          width,
          height,
          duration,
          creator: typeof v.creator === "object" && v.creator ? v.creator.name ?? "" : "",
          license: LICENSE,
          source_tags: sourceTags,
          thumbnail_url: urls.poster || urls.thumbnail || "",
          extra: { slug: v.slug, category: v.category },
        })
      );
    }
    return out;
  }

  download(candidate: Candidate, outPath: string): Promise<string> {
    return streamDownload(candidate.download_url, outPath);
  }
}
