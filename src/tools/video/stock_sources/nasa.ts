/** NASA Image and Video Library adapter (TS port of stock_sources/nasa.py). Keyless, two-stage. */
import { Candidate, type SearchFilters, type StockSource, streamDownload } from "./base.js";

const SEARCH_URL = "https://images-api.nasa.gov/search";
const UNSAFE_ID = /[^A-Za-z0-9._-]+/g;

function pickVideoUrl(urls: string[]): string {
  for (const p of ["orig", "large", "medium", "small"]) {
    for (const u of urls) {
      const l = u.toLowerCase();
      if ((l.endsWith(".mp4") || l.endsWith(".mov") || l.endsWith(".m4v")) && l.includes(`~${p}.`)) return u;
    }
  }
  for (const u of urls) if (u.toLowerCase().endsWith(".mp4")) return u;
  return "";
}
function pickImageUrl(urls: string[]): string {
  for (const p of ["orig", "large", "medium"]) {
    for (const u of urls) {
      const l = u.toLowerCase();
      if (/\.(jpg|jpeg|png|tif|tiff)$/.test(l) && l.includes(`~${p}.`)) return u;
    }
  }
  for (const u of urls) if (/\.(jpg|jpeg|png)$/.test(u.toLowerCase())) return u;
  return "";
}
function sanitizeId(raw: string): string {
  if (!raw) return "unknown";
  let c = raw.trim().replace(UNSAFE_ID, "_").replace(/_+/g, "_").replace(/^[_.]+|[_.]+$/g, "");
  return c ? c.slice(0, 120) : "unknown";
}
function encodeUrlPath(url: string): string {
  try {
    const u = new URL(url);
    u.pathname = u.pathname.split("/").map((seg) => encodeURIComponent(decodeURIComponent(seg))).join("/");
    return u.toString();
  } catch {
    return url;
  }
}

export class NasaSource implements StockSource {
  readonly name = "nasa";
  static readonly display_name = "NASA";
  static readonly provider = "nasa";
  static readonly priority = 30;
  static readonly install_instructions = "No setup required. NASA media search works without an API key; NASA_API_KEY is optional for higher rate limits.";
  static readonly supports = { video: true, image: true };

  isAvailable(): boolean {
    return true;
  }

  async search(query: string, filters: SearchFilters): Promise<Candidate[]> {
    const kind = (filters.kind || "video").toLowerCase();
    const mediaTypes: string[] = [];
    if (kind === "video" || kind === "any") mediaTypes.push("video");
    if (kind === "image" || kind === "any") mediaTypes.push("image");
    if (mediaTypes.length === 0) return [];
    const params = new URLSearchParams();
    params.set("q", query);
    for (const mt of mediaTypes) params.append("media_type", mt);
    params.set("page_size", String(Math.max(1, Math.min(filters.per_page, 100))));
    params.set("page", String(Math.max(1, filters.page)));
    const r = await fetch(`${SEARCH_URL}?${params}`);
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
    const data = (await r.json()) as { collection?: { items?: any[] } };
    const out: Candidate[] = [];
    for (const item of data.collection?.items ?? []) {
      const cand = await this.hydrate(item);
      if (cand) out.push(cand);
    }
    return out;
  }

  private async hydrate(item: any): Promise<Candidate | null> {
    const meta = (item.data ?? [])[0];
    if (!meta) return null;
    const nasaId = meta.nasa_id;
    const mediaType = String(meta.media_type ?? "").toLowerCase();
    if (!nasaId || (mediaType !== "video" && mediaType !== "image")) return null;
    const assetHref = item.href;
    if (!assetHref) return null;
    let fileUrls: unknown;
    try {
      const r = await fetch(assetHref);
      if (!r.ok) return null;
      fileUrls = await r.json();
    } catch {
      return null;
    }
    if (!Array.isArray(fileUrls) || fileUrls.length === 0) return null;
    let downloadUrl = mediaType === "video" ? pickVideoUrl(fileUrls as string[]) : pickImageUrl(fileUrls as string[]);
    if (!downloadUrl) return null;
    downloadUrl = encodeUrlPath(downloadUrl);
    const keywords = Array.isArray(meta.keywords) ? meta.keywords.filter(Boolean).join(" ") : String(meta.keywords ?? "");
    let tags = [String(meta.title ?? "").trim(), String(meta.description ?? "").trim(), keywords].filter(Boolean).join(" ").trim();
    if (tags.length > 500) tags = tags.slice(0, 500);
    let thumb = "";
    for (const link of item.links ?? []) if (link?.rel === "preview") { thumb = link.href ?? ""; break; }
    return new Candidate({
      source: this.name,
      source_id: sanitizeId(nasaId),
      source_url: `https://images.nasa.gov/details/${encodeURIComponent(nasaId)}`,
      download_url: downloadUrl,
      kind: mediaType,
      creator: String(meta.photographer ?? meta.center ?? "").trim(),
      license: "NASA Media Usage Guidelines (public domain with caveats)",
      source_tags: tags,
      thumbnail_url: thumb,
      extra: { center: meta.center, date_created: meta.date_created, secondary_creator: meta.secondary_creator },
    });
  }

  download(candidate: Candidate, outPath: string): Promise<string> {
    return streamDownload(candidate.download_url, outPath);
  }
}
