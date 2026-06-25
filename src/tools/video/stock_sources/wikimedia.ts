/** Wikimedia Commons media adapter (TS port of stock_sources/wikimedia.py). Keyless, MediaWiki API. */
import { Candidate, type SearchFilters, type StockSource, streamDownload } from "./base.js";

const API_URL = "https://commons.wikimedia.org/w/api.php";
const USER_AGENT = "MontagentBot/0.1 (https://github.com/calesthio/Montagent)";
const COMMONS_LICENSE = "Wikimedia Commons (verify per-file license)";
const STOP_WORDS = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "its", "their", "about", "over", "under", "while", "during", "your", "you", "our", "are", "was", "were", "have", "has"]);
const SOURCE_HINT = new Set(["prelinger", "archive", "archives", "stock", "footage"]);

function looksLikeYear(t: string): boolean {
  const b = t.replace(/s+$/, "");
  return /^\d+$/.test(b) && b.length === 4;
}
function buildQueries(query: string, kind: string): Array<[string, string]> {
  const k = (kind || "video").toLowerCase();
  const prefix = k === "video" ? "filetype:video" : k === "image" ? "filetype:image" : "";
  const wrap = (t: string) => (prefix ? `${prefix} ${t}`.trim() : t);
  const user = query.trim();
  if (!user) return [["default", wrap("")]];
  const tokens = user.split(/\s+/).filter((t) => t.length >= 3 && !STOP_WORDS.has(t.toLowerCase()) && !SOURCE_HINT.has(t.toLowerCase()));
  const nonYear = tokens.filter((t) => !looksLikeYear(t));
  const queries: Array<[string, string]> = [["full", wrap(user)]];
  if (nonYear.length >= 2) {
    const top2 = [...nonYear].sort((a, b) => b.length - a.length).slice(0, 2);
    queries.push(["top2_or", wrap(`${top2[0]} ${top2[1]}`)]);
  }
  if (nonYear.length) queries.push(["single_best", wrap(nonYear.reduce((a, b) => (b.length > a.length ? b : a)))]);
  return queries;
}
function metaValue(meta: any, key: string): string {
  const raw = meta?.[key]?.value ?? "";
  if (!raw) return "";
  return String(raw).replace(/<[^>]+>/g, " ").replace(/&[a-z]+;|&#\d+;/gi, " ").replace(/\s+/g, " ").trim();
}
function matchesOrientation(o: string, w: number, h: number): boolean {
  if (!w || !h) return true;
  if (o === "landscape") return w >= h;
  if (o === "portrait") return h > w;
  if (o === "square") return w === h;
  return true;
}
function kindFromMime(mime: string, title: string): string {
  if (mime.startsWith("video/") || /\.(webm|ogv|ogg)$/.test(title.toLowerCase())) return "video";
  return "image";
}

export class WikimediaSource implements StockSource {
  readonly name = "wikimedia";
  static readonly display_name = "Wikimedia Commons";
  static readonly provider = "wikimedia";
  static readonly priority = 25;
  static readonly install_instructions = "No setup required. Wikimedia Commons media search works without API keys.";
  static readonly supports = { video: true, image: true };

  isAvailable(): boolean {
    return true;
  }

  async search(query: string, filters: SearchFilters): Promise<Candidate[]> {
    const limit = Math.max(1, Math.min(filters.per_page, 50));
    for (const [, searchText] of buildQueries(query, filters.kind)) {
      const params = new URLSearchParams({
        action: "query",
        format: "json",
        generator: "search",
        gsrsearch: searchText,
        gsrnamespace: "6",
        gsrlimit: String(limit),
        gsroffset: String(Math.max(0, (Math.max(filters.page, 1) - 1) * limit)),
        prop: "imageinfo|info",
        iiprop: "url|size|mime|extmetadata|mediatype",
        iiurlwidth: "640",
        inprop: "url",
      });
      let pages: any[];
      try {
        const r = await fetch(`${API_URL}?${params}`, { headers: { "User-Agent": USER_AGENT } });
        if (!r.ok) continue;
        const data = (await r.json()) as { query?: { pages?: Record<string, any> } };
        pages = Object.values(data.query?.pages ?? {});
      } catch {
        continue;
      }
      if (pages.length === 0) continue;
      pages.sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));
      const out: Candidate[] = [];
      for (const page of pages) {
        const cand = this.pageToCandidate(page, filters);
        if (cand) out.push(cand);
      }
      if (out.length > 0) return out;
    }
    return [];
  }

  private pageToCandidate(page: any, filters: SearchFilters): Candidate | null {
    const info = (page.imageinfo ?? [])[0];
    if (!info) return null;
    const mime = String(info.mime ?? "").toLowerCase();
    const kind = kindFromMime(mime, page.title ?? "");
    const reqKind = (filters.kind || "video").toLowerCase();
    if (reqKind === "video" && kind !== "video") return null;
    if (reqKind === "image" && kind !== "image") return null;
    const width = Number(info.width ?? 0);
    const height = Number(info.height ?? 0);
    const duration = Number(info.duration ?? 0) || 0;
    if (filters.min_width != null && width && width < filters.min_width) return null;
    if (filters.min_duration != null && duration && duration < filters.min_duration) return null;
    if (filters.max_duration != null && duration && duration > filters.max_duration) return null;
    if (filters.orientation && !matchesOrientation(filters.orientation, width, height)) return null;
    const meta = info.extmetadata ?? {};
    let tags = [metaValue(meta, "ObjectName"), metaValue(meta, "ImageDescription"), metaValue(meta, "Categories")].filter(Boolean).join(" ").trim();
    if (tags.length > 500) tags = tags.slice(0, 500);
    const title = page.title ?? "";
    return new Candidate({
      source: this.name,
      source_id: String(page.pageid ?? title.replace("File:", "")),
      source_url: info.descriptionurl || page.canonicalurl || "",
      download_url: info.url ?? "",
      kind,
      width,
      height,
      duration,
      creator: metaValue(meta, "Artist"),
      license: metaValue(meta, "LicenseShortName") || metaValue(meta, "UsageTerms") || COMMONS_LICENSE,
      source_tags: tags,
      thumbnail_url: info.thumburl || info.url || "",
      extra: { mime, title, mediatype: info.mediatype, descriptionshorturl: info.descriptionshorturl },
    });
  }

  download(candidate: Candidate, outPath: string): Promise<string> {
    return streamDownload(candidate.download_url, outPath, { "User-Agent": USER_AGENT });
  }
}
