/** Pond5 Public Domain adapter (TS port of stock_sources/pond5_pd.py). Keyless API + web fallback. */
import { Candidate, type SearchFilters, type StockSource, streamDownload } from "./base.js";

const SEARCH_URL = "https://www.pond5.com/api/v2/search";
const LICENSE = "Public domain (CC0 equivalent, Pond5 Public Domain Project)";

export class Pond5PublicDomainSource implements StockSource {
  readonly name = "pond5_pd";
  static readonly display_name = "Pond5 Public Domain";
  static readonly provider = "pond5";
  static readonly priority = 38;
  static readonly install_instructions = "Pond5 Public Domain works without an API key for basic search. Set POND5_API_KEY in .env for higher rate limits and full API access.";
  static readonly supports = { video: true, image: true };

  isAvailable(): boolean {
    return true;
  }

  async search(query: string, filters: SearchFilters): Promise<Candidate[]> {
    const kind = (filters.kind || "video").toLowerCase();
    const params = new URLSearchParams({
      kw: query,
      page: String(Math.max(1, filters.page)),
      ps: String(Math.max(1, Math.min(filters.per_page, 50))),
      free: "1",
    });
    if (kind === "video") params.set("mt", "footage");
    else if (kind === "image") params.set("mt", "photos");
    const headers: Record<string, string> = { "User-Agent": "Montagent/1.0 (stock source adapter)" };
    if (process.env.POND5_API_KEY) headers.Authorization = `Bearer ${process.env.POND5_API_KEY}`;
    let data: { results?: any[]; items?: any[] };
    try {
      const r = await fetch(`${SEARCH_URL}?${params}`, { headers });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      data = (await r.json()) as typeof data;
    } catch {
      return []; // web fallback not implemented (mirrors Python's empty fallback)
    }
    return this.parseResults(data.results ?? data.items ?? [], kind, filters);
  }

  private parseResults(results: any[], kind: string, filters: SearchFilters): Candidate[] {
    const out: Candidate[] = [];
    for (const item of results) {
      const itemId = String(item.id ?? "");
      if (!itemId) continue;
      let keywords = item.kw ?? item.keywords ?? "";
      if (Array.isArray(keywords)) keywords = keywords.join(" ");
      const tags = `${item.t ?? item.title ?? ""} ${item.desc ?? item.description ?? ""} ${keywords}`.trim();
      const duration = Number(item.dur ?? item.duration ?? 0) || 0;
      if (kind === "video") {
        if (filters.min_duration && duration && duration < filters.min_duration) continue;
        if (filters.max_duration && duration && duration > filters.max_duration) continue;
      }
      const previewUrl = item.v || item.preview_url || item.icon_url || "";
      if (!previewUrl) continue;
      out.push(
        new Candidate({
          source: this.name,
          source_id: itemId,
          source_url: `https://www.pond5.com/stock-footage/${itemId}`,
          download_url: previewUrl,
          kind: kind === "image" ? "image" : "video",
          width: Number(item.w ?? item.width ?? 0),
          height: Number(item.h ?? item.height ?? 0),
          duration,
          creator: item.an || item.artist_name || "Pond5 Public Domain",
          license: LICENSE,
          source_tags: tags,
          thumbnail_url: item.ic || item.thumbnail_url || "",
          extra: { fps: item.fps, codec: item.codec },
        })
      );
    }
    return out;
  }

  download(candidate: Candidate, outPath: string): Promise<string> {
    return streamDownload(candidate.download_url, outPath);
  }
}
