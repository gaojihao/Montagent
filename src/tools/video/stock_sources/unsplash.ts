/** Unsplash stock photo adapter (TS port of stock_sources/unsplash.py). Image-only. */
import { Candidate, type SearchFilters, type StockSource, streamDownload } from "./base.js";

const SEARCH_URL = "https://api.unsplash.com/search/photos";
const UNSPLASH_LICENSE = "Unsplash License (use returned hotlinked image URLs)";
const USER_AGENT = "MontagentBot/0.1 (https://github.com/calesthio/Montagent)";

function orientationForUnsplash(o?: string | null): string | null {
  if (o === "landscape") return "landscape";
  if (o === "portrait") return "portrait";
  if (o === "square") return "squarish";
  return null;
}
function matchesOrientation(o: string, w: number, h: number): boolean {
  if (!w || !h) return true;
  if (o === "landscape") return w >= h;
  if (o === "portrait") return h > w;
  if (o === "square") return w === h;
  return true;
}
function buildDownloadUrl(rawUrl: string, targetWidth: number): string {
  const u = new URL(rawUrl);
  if (!u.searchParams.has("fm")) u.searchParams.set("fm", "jpg");
  if (!u.searchParams.has("q")) u.searchParams.set("q", "80");
  if (targetWidth > 0) {
    u.searchParams.set("w", String(targetWidth));
    if (!u.searchParams.has("fit")) u.searchParams.set("fit", "max");
  }
  return u.toString();
}

export class UnsplashSource implements StockSource {
  readonly name = "unsplash";
  static readonly display_name = "Unsplash";
  static readonly provider = "unsplash";
  static readonly priority = 18;
  static readonly install_instructions = "Set UNSPLASH_ACCESS_KEY in .env to enable Unsplash image search (see https://unsplash.com/documentation).";
  static readonly supports = { video: false, image: true };

  isAvailable(): boolean {
    return Boolean(process.env.UNSPLASH_ACCESS_KEY);
  }

  private headers(): Record<string, string> {
    const key = process.env.UNSPLASH_ACCESS_KEY;
    if (!key) throw new Error("UNSPLASH_ACCESS_KEY not set. Create an app at https://unsplash.com/documentation and add the access key to .env.");
    return { Authorization: `Client-ID ${key}`, "Accept-Version": "v1", "User-Agent": USER_AGENT };
  }

  async search(query: string, filters: SearchFilters): Promise<Candidate[]> {
    if ((filters.kind || "video").toLowerCase() === "video") return [];
    const params = new URLSearchParams({
      query,
      page: String(Math.max(1, filters.page)),
      per_page: String(Math.max(1, Math.min(filters.per_page, 30))),
      content_filter: "high",
    });
    const orient = orientationForUnsplash(filters.orientation);
    if (orient) params.set("orientation", orient);
    const r = await fetch(`${SEARCH_URL}?${params}`, { headers: this.headers() });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
    const data = (await r.json()) as { results?: any[] };
    const out: Candidate[] = [];
    for (const photo of data.results ?? []) {
      const width = Number(photo.width ?? 0);
      const height = Number(photo.height ?? 0);
      if (filters.min_width != null && width && width < filters.min_width) continue;
      if (filters.orientation && !matchesOrientation(filters.orientation, width, height)) continue;
      const urls = photo.urls ?? {};
      const rawUrl = urls.raw || urls.regular || "";
      if (!rawUrl) continue;
      const user = photo.user ?? {};
      const links = photo.links ?? {};
      let tags = [photo.description ?? "", photo.alt_description ?? "", photo.slug ?? ""].map((s) => s.trim()).filter(Boolean).join(" ").trim();
      if (tags.length > 500) tags = tags.slice(0, 500);
      out.push(
        new Candidate({
          source: this.name,
          source_id: String(photo.id ?? ""),
          source_url: links.html ?? "",
          download_url: buildDownloadUrl(rawUrl, Math.max(filters.min_width ?? 0, 1920)),
          kind: "image",
          width,
          height,
          duration: 0,
          creator: user.name ?? "",
          license: UNSPLASH_LICENSE,
          source_tags: tags,
          thumbnail_url: urls.small || urls.thumb || rawUrl,
          extra: { color: photo.color, blur_hash: photo.blur_hash, download_location: links.download_location, photographer_url: user.links?.html },
        })
      );
    }
    return out;
  }

  download(candidate: Candidate, outPath: string): Promise<string> {
    return streamDownload(candidate.download_url, outPath, { "User-Agent": USER_AGENT });
  }
}
