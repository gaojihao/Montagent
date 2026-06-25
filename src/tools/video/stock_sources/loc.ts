/** Library of Congress adapter (TS port of stock_sources/loc.py). Keyless JSON API. */
import { Candidate, hashId, type SearchFilters, type StockSource, streamDownload } from "./base.js";

const SEARCH_URL = "https://www.loc.gov/search/";
const LICENSE_PD = "Public domain (Library of Congress)";
const LICENSE_CHECK = "Rights status varies — verify per item (Library of Congress)";

export class LibraryOfCongressSource implements StockSource {
  readonly name = "loc";
  static readonly display_name = "Library of Congress";
  static readonly provider = "loc";
  static readonly priority = 40;
  static readonly install_instructions = "Library of Congress works without an API key. No setup needed.";
  static readonly supports = { video: true, image: true };

  isAvailable(): boolean {
    return true;
  }

  async search(query: string, filters: SearchFilters): Promise<Candidate[]> {
    const kind = (filters.kind || "video").toLowerCase();
    const params = new URLSearchParams({
      q: query,
      fo: "json",
      c: String(Math.max(1, Math.min(filters.per_page, 50))),
      sp: String(Math.max(1, filters.page)),
    });
    if (kind === "video") params.set("fa", "original-format:film/video");
    else if (kind === "image") params.set("fa", "original-format:photo, print, drawing");
    let results: any[];
    try {
      const r = await fetch(`${SEARCH_URL}?${params}`, { headers: { Accept: "application/json" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      results = ((await r.json()) as { results?: any[] }).results ?? [];
    } catch {
      return [];
    }
    const out: Candidate[] = [];
    for (const item of results) out.push(...this.extract(item, kind, filters));
    return out;
  }

  private extract(item: any, kind: string, _filters: SearchFilters): Candidate[] {
    const itemId = item.id ?? "";
    if (!itemId) return [];
    const title = item.title ?? "";
    let description = "";
    const descList = item.description;
    if (Array.isArray(descList) && descList.length) description = typeof descList[0] === "string" ? descList[0] : "";
    else if (typeof descList === "string") description = descList;
    let subjects = item.subject ?? [];
    if (Array.isArray(subjects)) subjects = subjects.filter((s: unknown) => typeof s === "string").join(" ");
    const tags = `${title} ${description} ${subjects}`.trim();
    const sourceUrl = String(itemId).startsWith("http") ? itemId : `https://www.loc.gov${itemId}`;
    let rights = item.rights ?? [];
    const rightsStr = (Array.isArray(rights) ? rights.filter((r: unknown) => typeof r === "string").join(" ") : String(rights)).toLowerCase();
    const lic = rightsStr.includes("public domain") || rightsStr.includes("no known") ? LICENSE_PD : LICENSE_CHECK;
    let imageUrl = "";
    if (Array.isArray(item.image_url)) imageUrl = item.image_url[0] ?? "";
    else if (typeof item.image_url === "string") imageUrl = item.image_url;
    const out: Candidate[] = [];
    for (const res of item.resources ?? []) {
      if (typeof res !== "object" || !res) continue;
      for (const fileGroup of res.files ?? []) {
        if (!Array.isArray(fileGroup)) continue;
        for (const f of fileGroup) {
          if (typeof f !== "object" || !f) continue;
          const url = f.url ?? "";
          const mime = String(f.mimetype ?? "").toLowerCase();
          if (!url) continue;
          const isVideo = mime.includes("video") || [".mp4", ".mov", ".avi", ".webm"].some((e) => url.toLowerCase().endsWith(e));
          const isImage = mime.includes("image") || [".jpg", ".jpeg", ".png", ".tif"].some((e) => url.toLowerCase().endsWith(e));
          if (kind === "video" && !isVideo) continue;
          if (kind === "image" && !isImage) continue;
          if (!isVideo && !isImage) continue;
          const fullUrl = String(url).startsWith("http") ? url : `https://www.loc.gov${url}`;
          out.push(
            new Candidate({
              source: this.name,
              source_id: `loc_${hashId(fullUrl)}`,
              source_url: sourceUrl,
              download_url: fullUrl,
              kind: isVideo ? "video" : "image",
              width: Number(f.width ?? 0),
              height: Number(f.height ?? 0),
              duration: 0,
              creator: "Library of Congress",
              license: lic,
              source_tags: tags,
              thumbnail_url: imageUrl,
              extra: { item_id: itemId, mime },
            })
          );
        }
      }
    }
    if (out.length === 0 && (kind === "image" || kind === "any") && imageUrl) {
      const fullUrl = imageUrl.startsWith("http") ? imageUrl : `https://www.loc.gov${imageUrl}`;
      out.push(
        new Candidate({
          source: this.name,
          source_id: `loc_${hashId(fullUrl)}`,
          source_url: sourceUrl,
          download_url: fullUrl,
          kind: "image",
          duration: 0,
          creator: "Library of Congress",
          license: lic,
          source_tags: tags,
          thumbnail_url: imageUrl,
          extra: { item_id: itemId },
        })
      );
    }
    return out;
  }

  download(candidate: Candidate, outPath: string): Promise<string> {
    return streamDownload(candidate.download_url, outPath);
  }
}
