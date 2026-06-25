/** Dareful nature footage adapter (TS port of stock_sources/dareful.py). Scraper (cheerio). */
import * as cheerio from "cheerio";
import { Candidate, type SearchFilters, type StockSource, streamDownload } from "./base.js";

const BASE_URL = "https://www.dareful.com";
const LICENSE = "Creative Commons Attribution 4.0 (CC BY 4.0, attribution required)";
const UA = { "User-Agent": "Montagent/1.0" };

export class DarefulSource implements StockSource {
  readonly name = "dareful";
  static readonly display_name = "Dareful";
  static readonly provider = "dareful";
  static readonly priority = 50;
  static readonly install_instructions = "Dareful works without an API key. Scrapes the Dareful website (HTML parsing via cheerio, bundled).";
  static readonly supports = { video: true, image: false };

  // Python gated on beautifulsoup4; cheerio is bundled in the TS port → always available.
  isAvailable(): boolean {
    return true;
  }

  async search(query: string, filters: SearchFilters): Promise<Candidate[]> {
    if ((filters.kind || "video").toLowerCase() === "image") return [];
    let html: string;
    try {
      const r = await fetch(`${BASE_URL}/?s=${encodeURIComponent(query)}`, { headers: UA });
      if (!r.ok) return [];
      html = await r.text();
    } catch {
      return [];
    }
    const $ = cheerio.load(html);
    const out: Candidate[] = [];
    $("article, .post, .entry, .video-item, .grid-item").slice(0, filters.per_page).each((_i, card) => {
      const $card = $(card);
      const linkEl = $card.find("a[href]").first();
      let href = linkEl.attr("href") ?? "";
      if (!href) return;
      if (!href.startsWith("http")) href = `${BASE_URL}${href}`;
      let title = $card.find("h2, h3, .entry-title, .title").first().text().trim();
      if (!title) title = linkEl.text().trim();
      const thumb = $card.find("img").first().attr("src") ?? $card.find("img").first().attr("data-src") ?? "";
      const clipId = href.replace(/\/+$/, "").split("/").pop() ?? "";
      out.push(
        new Candidate({
          source: this.name,
          source_id: `dareful_${clipId}`,
          source_url: href,
          download_url: href,
          kind: "video",
          width: 3840,
          height: 2160,
          duration: 0,
          creator: "Joel Holland (Dareful)",
          license: LICENSE,
          source_tags: `${title} nature landscape 4k ${query}`,
          thumbnail_url: thumb,
          extra: { detail_url: href },
        })
      );
    });
    return out;
  }

  async download(candidate: Candidate, outPath: string): Promise<string> {
    const detailUrl = (candidate.extra.detail_url as string) ?? candidate.download_url;
    if ([".mp4", ".mov", ".webm"].some((e) => detailUrl.toLowerCase().endsWith(e))) {
      return streamDownload(detailUrl, outPath, UA);
    }
    const r = await fetch(detailUrl, { headers: UA });
    if (!r.ok) throw new Error(`Dareful detail HTTP ${r.status}`);
    const $ = cheerio.load(await r.text());
    let dl = "";
    $("a[href]").each((_i, a) => {
      if (dl) return;
      const href = $(a).attr("href") ?? "";
      const text = $(a).text().trim().toLowerCase();
      if ([".mp4", ".mov", ".webm"].some((e) => href.toLowerCase().includes(e))) dl = href;
      else if (text.includes("download") && href) dl = href;
    });
    if (!dl) {
      const src = $("video source[src], video[src]").first().attr("src");
      if (src) dl = src;
    }
    if (!dl) throw new Error(`Could not find download URL on Dareful page: ${detailUrl}`);
    if (!dl.startsWith("http")) dl = `${BASE_URL}${dl}`;
    return streamDownload(dl, outPath, UA);
  }
}
