/** Pixabay Video stock source adapter (TS port of stock_sources/pixabay_video.py). */
import { Candidate, type SearchFilters, type StockSource, streamDownload } from "./base.js";

const API_URL = "https://pixabay.com/api/videos/";
const LICENSE = "Pixabay Content License (free, no attribution required)";

function pickRendition(videos: any, minWidth = 0): { url: string; width: number; height: number; size?: number } | null {
  for (const tier of ["large", "medium", "small", "tiny"]) {
    const rend = videos?.[tier];
    if (!rend || !rend.url) continue;
    const w = Number(rend.width ?? 0);
    const h = Number(rend.height ?? 0);
    if (w >= minWidth) return { url: rend.url, width: w, height: h, size: rend.size };
  }
  return null;
}

export class PixabayVideoSource implements StockSource {
  readonly name = "pixabay_video";
  static readonly display_name = "Pixabay Video";
  static readonly provider = "pixabay";
  static readonly priority = 15;
  static readonly install_instructions = "Set PIXABAY_API_KEY in .env to enable Pixabay Video search (free key at https://pixabay.com/api/docs/).";
  static readonly supports = { video: true, image: false };

  isAvailable(): boolean {
    return Boolean(process.env.PIXABAY_API_KEY);
  }

  async search(query: string, filters: SearchFilters): Promise<Candidate[]> {
    if ((filters.kind || "video").toLowerCase() === "image") return [];
    const params = new URLSearchParams({
      key: process.env.PIXABAY_API_KEY ?? "",
      q: query,
      per_page: String(Math.max(3, Math.min(filters.per_page, 200))),
      page: String(Math.max(1, filters.page)),
      safesearch: "true",
    });
    if (filters.min_duration != null) params.set("min_duration", String(Math.trunc(filters.min_duration)));
    if (filters.max_duration != null) params.set("max_duration", String(Math.trunc(filters.max_duration)));
    const r = await fetch(`${API_URL}?${params}`);
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
    const data = (await r.json()) as { hits?: any[] };
    const out: Candidate[] = [];
    for (const h of data.hits ?? []) {
      const rend = pickRendition(h.videos ?? {}, filters.min_width ?? 0);
      if (!rend) continue;
      out.push(
        new Candidate({
          source: this.name,
          source_id: String(h.id),
          source_url: h.pageURL ?? "",
          download_url: rend.url,
          kind: "video",
          width: rend.width,
          height: rend.height,
          duration: Number(h.duration ?? 0) || 0,
          creator: h.user ?? "",
          license: LICENSE,
          source_tags: h.tags ?? "",
          thumbnail_url: h.userImageURL ?? h.videos?.tiny?.thumbnail ?? "",
          extra: { views: h.views, downloads: h.downloads, rendition_size: rend.size },
        })
      );
    }
    return out;
  }

  download(candidate: Candidate, outPath: string): Promise<string> {
    return streamDownload(candidate.download_url, outPath);
  }
}
