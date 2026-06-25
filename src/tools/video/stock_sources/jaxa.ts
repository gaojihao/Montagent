/** JAXA Digital Archives adapter (TS port of stock_sources/jaxa.py). Scraper (cheerio). */
import * as cheerio from "cheerio";
import { Candidate, hashId, type SearchFilters, type StockSource, streamDownload } from "./base.js";

const BASE_URL = "https://jda.jaxa.jp";
const SEARCH_URL = "https://jda.jaxa.jp/result.php";
const LICENSE = "JAXA Digital Archives License (educational/informational use, verify per item)";
const UA = { "User-Agent": "Montagent/1.0" };

export class JAXASource implements StockSource {
  readonly name = "jaxa";
  static readonly display_name = "JAXA (Japan Space Agency)";
  static readonly provider = "jaxa";
  static readonly priority = 55;
  static readonly install_instructions = "JAXA works without an API key. Scrapes the JAXA Digital Archives (cheerio, bundled).";
  static readonly supports = { video: true, image: true };

  isAvailable(): boolean {
    return true;
  }

  async search(query: string, filters: SearchFilters): Promise<Candidate[]> {
    const kind = (filters.kind || "video").toLowerCase();
    const params = new URLSearchParams({ lang: "e", keyword: query });
    if (kind === "video") params.set("category", "3");
    else if (kind === "image") params.set("category", "1");
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
    $(".result-item, .photo-item, .movie-item, .item, li.list-item, .gallery-item").slice(0, filters.per_page).each((_i, el) => {
      const $el = $(el);
      const linkEl = $el.find("a[href]").first();
      let href = linkEl.attr("href") ?? "";
      if (!href) return;
      if (!href.startsWith("http")) href = `${BASE_URL}/${href.replace(/^\/+/, "")}`;
      let title = $el.find(".title, h3, h2, p, .caption").first().text().trim();
      if (!title) title = linkEl.text().trim();
      const thumb = $el.find("img").first().attr("src") ?? $el.find("img").first().attr("data-src") ?? "";
      const candKind = kind === "image" ? "image" : "video";
      out.push(
        new Candidate({
          source: this.name,
          source_id: `jaxa_${hashId(href)}`,
          source_url: href,
          download_url: href,
          kind: candKind,
          duration: 0,
          creator: "JAXA (Japan Aerospace Exploration Agency)",
          license: LICENSE,
          source_tags: `${title} space jaxa ${query}`,
          thumbnail_url: thumb,
          extra: { detail_url: href },
        })
      );
    });
    return out;
  }

  async download(candidate: Candidate, outPath: string): Promise<string> {
    const detailUrl = (candidate.extra.detail_url as string) ?? candidate.download_url;
    if ([".mp4", ".mov", ".webm", ".jpg", ".png"].some((e) => detailUrl.toLowerCase().endsWith(e))) return streamDownload(detailUrl, outPath, UA);
    const r = await fetch(detailUrl, { headers: UA });
    if (!r.ok) throw new Error(`JAXA detail HTTP ${r.status}`);
    const $ = cheerio.load(await r.text());
    let dl = $("video source[src], video[src]").first().attr("src") ?? "";
    if (!dl) {
      $("a[href]").each((_i, a) => {
        if (dl) return;
        const href = $(a).attr("href") ?? "";
        if ([".mp4", ".mov", ".webm"].some((e) => href.toLowerCase().includes(e))) dl = href;
      });
    }
    if (!dl) throw new Error(`Could not find download URL on JAXA page: ${detailUrl}`);
    if (!dl.startsWith("http")) dl = `${BASE_URL}/${dl.replace(/^\/+/, "")}`;
    return streamDownload(dl, outPath, UA);
  }
}
