/**
 * Archive.org public-domain video adapter (TS port of stock_sources/archive_org.py).
 * Keyless. Two-stage fetch: advancedsearch for identifiers, then per-item /metadata
 * for file lists. 3-stage Solr query cascade. requests -> fetch.
 */
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Candidate, type SearchFilters, type StockSource } from "./base.js";

const SEARCH_URL = "https://archive.org/advancedsearch.php";
const METADATA_URL = "https://archive.org/metadata";
const DOWNLOAD_URL = "https://archive.org/download";
const DEFAULT_COLLECTIONS = ["prelinger", "opensource_movies", "home_movies"];
const VIDEO_FORMAT_PRIORITY = ["h.264", "MPEG4", "h.264 HD", "512Kb MPEG4", "Matroska", "WebM"];
const MAX_FILE_SIZE_BYTES = 150 * 1024 * 1024;
const DEFAULT_MAX_DURATION_SECONDS = 180.0;
const STOP_WORDS = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "its", "their", "about", "over", "under", "while", "during", "your", "you", "our", "are", "was", "were", "have", "has"]);
const SOURCE_HINT_TOKENS = new Set(["prelinger", "archive", "archives", "stock", "footage"]);

function looksLikeYear(token: string): boolean {
  const bare = token.replace(/s+$/, "");
  return /^\d+$/.test(bare) && bare.length === 4;
}
function safeInt(value: unknown): number {
  if (value == null) return 0;
  const n = parseInt(String(value), 10);
  if (!Number.isNaN(n)) return n;
  const f = parseFloat(String(value));
  return Number.isNaN(f) ? 0 : Math.trunc(f);
}
function toText(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.filter((x) => x != null).map(String).join(" ").trim();
  return String(value).trim();
}
function parseLength(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  const s = String(value).trim();
  if (!s) return 0;
  let m = s.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + parseFloat(m[3]!);
  m = s.match(/^(\d+):(\d+(?:\.\d+)?)$/);
  if (m) return Number(m[1]) * 60 + parseFloat(m[2]!);
  const f = parseFloat(s);
  return Number.isNaN(f) ? 0 : f;
}
function licenseFromCollection(collection: string): string {
  const col = collection.toLowerCase();
  if (col.includes("prelinger")) return "Public Domain (Prelinger Archives)";
  if (col.includes("home_movies")) return "Public Domain (archive.org home movies)";
  return "Public Domain / CC (archive.org — verify per item)";
}
function pickVideoFile(files: any[]): any | null {
  if (!files || files.length === 0) return null;
  const byFormat = new Map<string, any[]>();
  for (const f of files) {
    const fmt = String(f.format ?? "").trim();
    const name = String(f.name ?? "").toLowerCase();
    if (!VIDEO_FORMAT_PRIORITY.includes(fmt)) continue;
    if (["thumb", "preview", ".gif"].some((tag) => name.includes(tag))) continue;
    if (!byFormat.has(fmt)) byFormat.set(fmt, []);
    byFormat.get(fmt)!.push(f);
  }
  for (const fmt of VIDEO_FORMAT_PRIORITY) {
    const bucket = byFormat.get(fmt);
    if (!bucket) continue;
    const affordable = bucket.filter((f) => safeInt(f.size) > 0 && safeInt(f.size) <= MAX_FILE_SIZE_BYTES);
    if (affordable.length === 0) continue;
    affordable.sort((a, b) => safeInt(b.size) - safeInt(a.size));
    return affordable[0];
  }
  return null;
}

export class ArchiveOrgSource implements StockSource {
  readonly name = "archive_org";
  static readonly display_name = "Archive.org";
  static readonly provider = "archive_org";
  static readonly priority = 20;
  static readonly install_instructions = "No setup required. Archive.org is available without API keys.";
  static readonly supports = { video: true, image: false };

  isAvailable(): boolean {
    return true;
  }

  private buildQueries(userQuery: string): Array<[string, string]> {
    const coll = DEFAULT_COLLECTIONS.map((c) => `collection:${c}`).join(" OR ");
    const user = userQuery.trim();
    if (!user) return [["default", `mediatype:movies AND (${coll})`]];
    const tokens = user.split(/\s+/).filter((t) => t.length >= 3 && !STOP_WORDS.has(t.toLowerCase()) && !SOURCE_HINT_TOKENS.has(t.toLowerCase()));
    if (tokens.length === 0) return [["quoted_fallback", `mediatype:movies AND (${coll}) AND ("${user}")`]];
    const queries: Array<[string, string]> = [];
    const cleanPhrase = tokens.join(" ");
    queries.push(["phrase_prox_10", `mediatype:movies AND (${coll}) AND ("${cleanPhrase}"~10)`]);
    const nonYear = tokens.filter((t) => !looksLikeYear(t));
    if (nonYear.length >= 2) {
      const distinctive = [...nonYear].sort((a, b) => b.length - a.length).slice(0, 2);
      queries.push(["distinctive_and", `mediatype:movies AND (${coll}) AND (${distinctive.join(" AND ")})`]);
    } else if (nonYear.length === 1) {
      queries.push(["single_term", `mediatype:movies AND (${coll}) AND (${nonYear[0]})`]);
    }
    const topTokens = [...tokens].sort((a, b) => b.length - a.length).slice(0, 3);
    queries.push(["distinctive_or", `mediatype:movies AND (${coll}) AND (${topTokens.join(" OR ")})`]);
    return queries;
  }

  async search(query: string, filters: SearchFilters): Promise<Candidate[]> {
    const kind = (filters.kind || "video").toLowerCase();
    if (kind !== "video" && kind !== "any") return [];
    for (const [, solrQ] of this.buildQueries(query)) {
      const params = new URLSearchParams();
      params.set("q", solrQ);
      for (const fl of ["identifier", "title", "description", "creator", "date", "subject", "licenseurl", "collection"]) params.append("fl[]", fl);
      params.set("rows", String(Math.max(1, Math.min(filters.per_page, 50))));
      params.set("page", String(Math.max(1, filters.page)));
      params.set("output", "json");
      let docs: any[];
      try {
        const r = await fetch(`${SEARCH_URL}?${params}`);
        if (!r.ok) continue;
        const data = (await r.json()) as { response?: { docs?: any[] } };
        docs = data.response?.docs ?? [];
      } catch {
        continue;
      }
      if (docs.length === 0) continue;
      const out: Candidate[] = [];
      for (const doc of docs) {
        const cand = await this.hydrateCandidate(doc, filters);
        if (cand) out.push(cand);
      }
      if (out.length > 0) return out;
    }
    return [];
  }

  private async hydrateCandidate(doc: any, filters: SearchFilters): Promise<Candidate | null> {
    const identifier = doc.identifier;
    if (!identifier) return null;
    let meta: { files?: any[] };
    try {
      const r = await fetch(`${METADATA_URL}/${identifier}`);
      if (!r.ok) return null;
      meta = (await r.json()) as { files?: any[] };
    } catch {
      return null;
    }
    const picked = pickVideoFile(meta.files ?? []);
    if (!picked) return null;
    const duration = parseLength(picked.length);
    const effMax = filters.max_duration ?? DEFAULT_MAX_DURATION_SECONDS;
    if (filters.min_duration != null && duration && duration < filters.min_duration) return null;
    if (duration && duration > effMax) return null;
    const width = safeInt(picked.width);
    const height = safeInt(picked.height);
    if (filters.min_width != null && width && width < filters.min_width) return null;
    const fileName = picked.name ?? "";
    let sourceTags = [toText(doc.title), toText(doc.description), toText(doc.subject)].filter(Boolean).join(" ").trim();
    if (sourceTags.length > 500) sourceTags = sourceTags.slice(0, 500);
    const collection = toText(doc.collection);
    const licenseText = toText(doc.licenseurl) || licenseFromCollection(collection);
    return new Candidate({
      source: this.name,
      source_id: identifier,
      source_url: `https://archive.org/details/${identifier}`,
      download_url: `${DOWNLOAD_URL}/${identifier}/${fileName}`,
      kind: "video",
      width,
      height,
      duration,
      creator: toText(doc.creator),
      license: licenseText,
      source_tags: sourceTags,
      thumbnail_url: `https://archive.org/services/img/${identifier}`,
      extra: { collection, date: toText(doc.date), format: picked.format, file_name: fileName, file_size_bytes: safeInt(picked.size) },
    });
  }

  async download(candidate: Candidate, outPath: string): Promise<string> {
    if (!candidate.download_url) throw new Error(`Candidate ${candidate.clip_id} has no download_url`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const r = await fetch(candidate.download_url);
    if (!r.ok || !r.body) throw new Error(`download HTTP ${r.status}`);
    await pipeline(Readable.fromWeb(r.body as any), fs.createWriteStream(outPath));
    return outPath;
  }
}
