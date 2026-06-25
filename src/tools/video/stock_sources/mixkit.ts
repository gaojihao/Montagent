/** Mixkit (Envato) stock video adapter (TS port of stock_sources/mixkit.py). Scraper (cheerio). */
import * as cheerio from "cheerio";
import { Candidate, type SearchFilters, type StockSource, streamDownload } from "./base.js";

const LICENSE = "Mixkit License (free for commercial and personal use, no attribution required)";
const UA = { "User-Agent": "Montagent/1.0" };

export class MixkitSource implements StockSource {
  readonly name = "mixkit";
  static readonly display_name = "Mixkit";
  static readonly provider = "envato";
  static readonly priority = 19;
  static readonly install_instructions = "Mixkit works without an API key. Scrapes the Mixkit website (HTML parsing via cheerio, bundled).";
  static readonly supports = { video: true, image: false };

  isAvailable(): boolean {
    return true;
  }

  async search(query: string, filters: SearchFilters): Promise<Candidate[]> {
    if ((filters.kind || "video").toLowerCase() === "image") return [];
    const slug = query.toLowerCase().replace(/\s+/g, "-");
    let html: string;
    try {
      const r = await fetch(`https://mixkit.co/free-stock-video/${slug}/`, { headers: UA });
      if (!r.ok) return [];
      html = await r.text();
    } catch {
      return [];
    }
    const $ = cheerio.load(html);
    const out: Candidate[] = [];
    $(".item-grid__item, .video-item, article, [class*='VideoCard']").slice(0, filters.per_page).each((_i, card) => {
      const $card = $(card);
      const linkEl = $card.find("a[href]").first();
      let href = linkEl.attr("href") ?? "";
      if (!href) return;
      if (!href.startsWith("http")) href = `https://mixkit.co${href}`;
      if (!href.includes("/free-stock-video/") && !href.includes("/video/")) return;
      let title = $card.find("h3, h2, .title, [class*='title']").first().text().trim();
      if (!title) title = linkEl.text().trim();
      const thumb = $card.find("img").first().attr("src") ?? $card.find("img").first().attr("data-src") ?? "";
      const previewUrl = $card.find("video source[src], video[src]").first().attr("src") ?? "";
      const clipId = href.replace(/\/+$/, "").split("/").pop() ?? "";
      out.push(
        new Candidate({
          source: this.name,
          source_id: `mixkit_${clipId}`,
          source_url: href,
          download_url: href,
          kind: "video",
          duration: 0,
          creator: "Mixkit",
          license: LICENSE,
          source_tags: `${title} ${query}`,
          thumbnail_url: thumb,
          extra: { detail_url: href, preview_url: previewUrl },
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
    if (!r.ok) throw new Error(`Mixkit detail HTTP ${r.status}`);
    const $ = cheerio.load(await r.text());
    let dl = "";
    $("a[href]").each((_i, a) => {
      if (dl) return;
      const href = $(a).attr("href") ?? "";
      const text = $(a).text().trim().toLowerCase();
      const classes = ($(a).attr("class") ?? "").toLowerCase();
      if (text.includes("download") || classes.includes("download")) {
        if (href && [".mp4", ".mov", ".webm"].some((e) => href.toLowerCase().includes(e))) dl = href;
        else if (href && href.includes("/download/")) dl = href;
      }
    });
    if (!dl) {
      $("video source[src]").each((_i, s) => {
        if (dl) return;
        const src = $(s).attr("src") ?? "";
        if ([".mp4", ".mov"].some((e) => src.toLowerCase().includes(e))) dl = src;
      });
    }
    if (!dl) throw new Error(`Could not find download URL on Mixkit page: ${detailUrl}`);
    if (!dl.startsWith("http")) dl = `https://mixkit.co${dl}`;
    return streamDownload(dl, outPath, UA);
  }
}
