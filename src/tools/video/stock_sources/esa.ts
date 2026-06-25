/** European Space Agency adapter (TS port of stock_sources/esa.py). Scraper (cheerio). */
import * as cheerio from "cheerio";
import { Candidate, hashId, type SearchFilters, type StockSource, streamDownload } from "./base.js";

const SEARCH_URL = "https://www.esa.int/ESA_Multimedia/Search";
const LICENSE = "CC BY-SA 3.0 IGO (ESA, attribution required)";
const UA = { "User-Agent": "Montagent/1.0" };

export class ESASource implements StockSource {
  readonly name = "esa";
  static readonly display_name = "ESA (European Space Agency)";
  static readonly provider = "esa";
  static readonly priority = 45;
  static readonly install_instructions = "ESA works without an API key. Scrapes the ESA Multimedia gallery (cheerio, bundled).";
  static readonly supports = { video: true, image: true };

  isAvailable(): boolean {
    return true;
  }

  async search(query: string, filters: SearchFilters): Promise<Candidate[]> {
    const kind = (filters.kind || "video").toLowerCase();
    const params = new URLSearchParams({ SearchText: query, result_type: kind === "video" ? "videos" : kind === "image" ? "images" : "" });
    let html: string;
    try {
      const r = await fetch(`${SEARCH_URL}?${params}`, { headers: UA });
      if (!r.ok) return [];
      html = await r.text();
    } catch {
      return [];
    }
    const $ = cheerio.load(html);
    const out: Candidate[] = [];
    $(".grid-item, .media-item, .search-result-item, article").slice(0, filters.per_page).each((_i, card) => {
      const $card = $(card);
      const linkEl = $card.find("a[href]").first();
      let href = linkEl.attr("href") ?? "";
      if (!href) return;
      if (!href.startsWith("http")) href = `https://www.esa.int${href}`;
      const title = $card.find("h3, h2, .title, .card-title").first().text().trim();
      let thumb = $card.find("img").first().attr("src") ?? $card.find("img").first().attr("data-src") ?? "";
      if (thumb && !thumb.startsWith("http")) thumb = `https://www.esa.int${thumb}`;
      const isVideo = href.includes("/Videos/") || href.includes("/Video/");
      const candKind = isVideo ? "video" : "image";
      if (kind === "video" && !isVideo) return;
      if (kind === "image" && isVideo) return;
      out.push(
        new Candidate({
          source: this.name,
          source_id: `esa_${hashId(href)}`,
          source_url: href,
          download_url: href,
          kind: candKind,
          duration: 0,
          creator: "European Space Agency (ESA)",
          license: LICENSE,
          source_tags: title,
          thumbnail_url: thumb,
          extra: { detail_url: href },
        })
      );
    });
    return out;
  }

  async download(candidate: Candidate, outPath: string): Promise<string> {
    const detailUrl = (candidate.extra.detail_url as string) ?? candidate.download_url;
    if ([".mp4", ".mov", ".jpg", ".png"].some((e) => detailUrl.toLowerCase().endsWith(e))) return streamDownload(detailUrl, outPath, UA);
    const r = await fetch(detailUrl, { headers: UA });
    if (!r.ok) throw new Error(`ESA detail HTTP ${r.status}`);
    const $ = cheerio.load(await r.text());
    let dl = "";
    $("a[href]").each((_i, a) => {
      if (dl) return;
      const href = $(a).attr("href") ?? "";
      const text = $(a).text().trim().toLowerCase();
      if ([".mp4", ".mov", ".webm"].some((e) => href.toLowerCase().includes(e))) dl = href;
      else if (text.includes("download") && href) dl = href;
    });
    if (!dl) dl = $("video source[src], source[src]").first().attr("src") ?? "";
    if (!dl) throw new Error(`Could not find download URL on ESA detail page: ${detailUrl}`);
    if (!dl.startsWith("http")) dl = `https://www.esa.int${dl}`;
    return streamDownload(dl, outPath, UA);
  }
}
