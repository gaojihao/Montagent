/** U.S. National Archives (NARA) adapter (TS port of stock_sources/nara.py). Keyless API. */
import { Candidate, type SearchFilters, type StockSource, streamDownload } from "./base.js";

const SEARCH_URL = "https://catalog.archives.gov/api/v2/search";
const LICENSE = "Public domain (U.S. federal government work)";

export class NARASource implements StockSource {
  readonly name = "nara";
  static readonly display_name = "U.S. National Archives";
  static readonly provider = "nara";
  static readonly priority = 35;
  static readonly install_instructions = "NARA works without an API key. Set NARA_API_KEY in .env for higher rate limits.";
  static readonly supports = { video: true, image: true };

  isAvailable(): boolean {
    return true;
  }

  async search(query: string, filters: SearchFilters): Promise<Candidate[]> {
    const kind = (filters.kind || "video").toLowerCase();
    const params = new URLSearchParams({
      q: query,
      rows: String(Math.max(1, Math.min(filters.per_page, 50))),
      offset: String((Math.max(1, filters.page) - 1) * filters.per_page),
    });
    if (kind === "video") params.set("type", "moving-image");
    else if (kind === "image") params.set("type", "still-image");
    const headers: Record<string, string> = {};
    if (process.env.NARA_API_KEY) headers["x-api-key"] = process.env.NARA_API_KEY;
    let results: any[];
    try {
      const r = await fetch(`${SEARCH_URL}?${params}`, { headers });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      results = ((await r.json()) as { results?: any[] }).results ?? [];
    } catch {
      return [];
    }
    const out: Candidate[] = [];
    for (const item of results) out.push(...this.extract(item, kind, filters));
    return out;
  }

  private extract(item: any, kind: string, filters: SearchFilters): Candidate[] {
    const naid = String(item.naId ?? "");
    if (!naid) return [];
    const tags = `${item.title ?? ""} ${item.scopeAndContentNote ?? ""}`.trim();
    const sourceUrl = `https://catalog.archives.gov/id/${naid}`;
    const objects = item.objects ?? item.digitalObjects ?? [];
    const out: Candidate[] = [];
    for (const obj of objects) {
      const fileUrl = obj.url || obj.fileUrl || "";
      if (!fileUrl) continue;
      const mime = String(obj.mimeType ?? "").toLowerCase();
      const ext = fileUrl.includes(".") ? fileUrl.split(".").pop()!.toLowerCase() : "";
      const isVideo = mime.includes("video") || ["mp4", "mov", "avi", "wmv", "mkv", "webm"].includes(ext);
      const isImage = mime.includes("image") || ["jpg", "jpeg", "png", "tif", "tiff", "gif"].includes(ext);
      if (kind === "video" && !isVideo) continue;
      if (kind === "image" && !isImage) continue;
      if (!isVideo && !isImage) continue;
      const candKind = isVideo ? "video" : "image";
      const duration = Number(obj.duration ?? 0) || 0;
      if (candKind === "video") {
        if (filters.min_duration && duration && duration < filters.min_duration) continue;
        if (filters.max_duration && duration && duration > filters.max_duration) continue;
      }
      out.push(
        new Candidate({
          source: this.name,
          source_id: `${naid}_${obj.objectId ?? out.length}`,
          source_url: sourceUrl,
          download_url: fileUrl,
          kind: candKind,
          width: Number(obj.width ?? 0),
          height: Number(obj.height ?? 0),
          duration,
          creator: "U.S. National Archives",
          license: LICENSE,
          source_tags: tags,
          thumbnail_url: obj.thumbnailUrl ?? "",
          extra: { naId: naid, mime, fileSize: obj.fileSize },
        })
      );
    }
    return out;
  }

  download(candidate: Candidate, outPath: string): Promise<string> {
    return streamDownload(candidate.download_url, outPath);
  }
}
