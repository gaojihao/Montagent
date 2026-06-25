/** Videvo stock video adapter (TS port of stock_sources/videvo.py). Keyed; free clips only. */
import { Candidate, type SearchFilters, type StockSource, streamDownload } from "./base.js";

const API_URL = "https://api.videvo.net/v1/search";
const LICENSE_ATTR = "Videvo Attribution License (free, attribution required)";
const LICENSE_CC = "Creative Commons 3.0 (CC BY 3.0, attribution required)";

export class VidevoSource implements StockSource {
  readonly name = "videvo";
  static readonly display_name = "Videvo";
  static readonly provider = "videvo";
  static readonly priority = 22;
  static readonly install_instructions = "Set VIDEVO_API_KEY in .env to enable Videvo stock search (get API access at https://www.videvo.net/api/).";
  static readonly supports = { video: true, image: false };

  isAvailable(): boolean {
    return Boolean(process.env.VIDEVO_API_KEY);
  }

  async search(query: string, filters: SearchFilters): Promise<Candidate[]> {
    if ((filters.kind || "video").toLowerCase() === "image") return [];
    const apiKey = process.env.VIDEVO_API_KEY;
    if (!apiKey) return [];
    const params = new URLSearchParams({
      query,
      page: String(Math.max(1, filters.page)),
      per_page: String(Math.max(1, Math.min(filters.per_page, 50))),
      license_type: "free",
    });
    if (filters.orientation) params.set("orientation", filters.orientation);
    let data: { data?: any[]; results?: any[]; clips?: any[] };
    try {
      const r = await fetch(`${API_URL}?${params}`, { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      data = (await r.json()) as typeof data;
    } catch {
      return [];
    }
    const hits = data.data ?? data.results ?? data.clips ?? [];
    const out: Candidate[] = [];
    for (const v of hits) {
      const duration = Number(v.duration ?? 0) || 0;
      if (filters.min_duration != null && duration < filters.min_duration) continue;
      if (filters.max_duration != null && duration > filters.max_duration) continue;
      const downloadUrl = v.download_url || v.url_hd || v.url_sd || v.preview_url || "";
      if (!downloadUrl) continue;
      const width = Number(v.width ?? 0);
      const height = Number(v.height ?? 0);
      if (filters.min_width && width && width < filters.min_width) continue;
      let tags = v.tags ?? v.keywords ?? "";
      if (Array.isArray(tags)) tags = tags.join(" ");
      const sourceTags = `${v.title ?? ""} ${tags}`.trim();
      const licType = String(v.license_type ?? "").toLowerCase();
      const lic = licType.includes("creative commons") || licType.includes("cc") ? LICENSE_CC : LICENSE_ATTR;
      const clipId = String(v.id ?? "");
      out.push(
        new Candidate({
          source: this.name,
          source_id: clipId,
          source_url: v.page_url || v.url || `https://www.videvo.net/video/${clipId}/`,
          download_url: downloadUrl,
          kind: "video",
          width,
          height,
          duration,
          creator: v.author || v.contributor || "",
          license: lic,
          source_tags: sourceTags,
          thumbnail_url: v.thumbnail_url || v.poster_url || "",
          extra: { fps: v.fps, resolution: v.resolution, category: v.category },
        })
      );
    }
    return out;
  }

  download(candidate: Candidate, outPath: string): Promise<string> {
    return streamDownload(candidate.download_url, outPath);
  }
}
