/** NOAA ocean/atmosphere adapter (TS port of stock_sources/noaa.py). Scraper (cheerio). Video-only. */
import * as cheerio from "cheerio";
import { Candidate, hashId, type SearchFilters, type StockSource, streamDownload } from "./base.js";

const LICENSE = "Public domain (U.S. federal government work, NOAA)";
const UA = { "User-Agent": "Montagent/1.0" };

export class NOAASource implements StockSource {
  readonly name = "noaa";
  static readonly display_name = "NOAA (Ocean & Atmosphere)";
  static readonly provider = "noaa";
  static readonly priority = 48;
  static readonly install_instructions = "NOAA works without an API key. Scrapes the NOAA multimedia pages (cheerio, bundled).";
  static readonly supports = { video: true, image: true };

  isAvailable(): boolean {
    return true;
  }

  async search(query: string, filters: SearchFilters): Promise<Candidate[]> {
    if ((filters.kind || "video").toLowerCase() === "image") return [];
    const out: Candidate[] = [];
    try {
      const r = await fetch(`https://www.noaa.gov/search?query=${encodeURIComponent(query)}&type=video`, { headers: UA });
      if (!r.ok) return [];
      const $ = cheerio.load(await r.text());
      $(".views-row, .search-result, article, .media-item").slice(0, filters.per_page).each((_i, card) => {
        const $card = $(card);
        const linkEl = $card.find("a[href]").first();
        let href = linkEl.attr("href") ?? "";
        if (!href) return;
        if (!href.startsWith("http")) href = `https://www.noaa.gov${href}`;
        let title = $card.find("h2, h3, .title, .field-content").first().text().trim();
        if (!title) title = linkEl.text().trim();
        let thumb = $card.find("img").first().attr("src") ?? $card.find("img").first().attr("data-src") ?? "";
        if (thumb && !thumb.startsWith("http")) thumb = `https://www.noaa.gov${thumb}`;
        out.push(
          new Candidate({
            source: this.name,
            source_id: `noaa_${hashId(href)}`,
            source_url: href,
            download_url: href,
            kind: "video",
            duration: 0,
            creator: "NOAA",
            license: LICENSE,
            source_tags: `${title} ocean marine weather atmosphere ${query}`,
            thumbnail_url: thumb,
            extra: { detail_url: href },
          })
        );
      });
    } catch {
      /* return what we have */
    }
    return out;
  }

  async download(candidate: Candidate, outPath: string): Promise<string> {
    const detailUrl = (candidate.extra.detail_url as string) ?? candidate.download_url;
    if ([".mp4", ".mov", ".webm"].some((e) => detailUrl.toLowerCase().endsWith(e))) return streamDownload(detailUrl, outPath, UA);
    const r = await fetch(detailUrl, { headers: UA });
    if (!r.ok) throw new Error(`NOAA detail HTTP ${r.status}`);
    const $ = cheerio.load(await r.text());
    let dl = $("video source[src], video[src]").first().attr("src") ?? "";
    if (!dl) {
      $("a[href]").each((_i, a) => {
        if (dl) return;
        const href = $(a).attr("href") ?? "";
        if ([".mp4", ".mov", ".webm"].some((e) => href.toLowerCase().includes(e))) dl = href;
      });
    }
    if (!dl) {
      const iframe = $("iframe[src]").first().attr("src") ?? "";
      if (iframe.includes("youtube") || iframe.includes("vimeo")) throw new Error(`Video is embedded from external platform: ${iframe}`);
    }
    if (!dl) throw new Error(`Could not find video URL on NOAA page: ${detailUrl}`);
    if (!dl.startsWith("http")) dl = `https://www.noaa.gov${dl}`;
    return streamDownload(dl, outPath, UA);
  }
}
