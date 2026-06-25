/**
 * Pexels stock media source adapter (TS port of stock_sources/pexels.py).
 * Wraps the Pexels video + image search APIs behind the StockSource protocol.
 * requests -> fetch; streamed download via node:stream.
 */
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Candidate, type SearchFilters, type StockSource } from "./base.js";

const VIDEO_SEARCH_URL = "https://api.pexels.com/videos/search";
const IMAGE_SEARCH_URL = "https://api.pexels.com/v1/search";
const PEXELS_LICENSE = "Pexels License (free, no attribution required)";

function pickVideoRendition(videoFiles: any[], minWidth = 0, maxWidth = 1920): any | null {
  const candidates = videoFiles.filter(
    (f) =>
      String(f.file_type ?? "").startsWith("video/") &&
      minWidth <= Number(f.width ?? 0) &&
      Number(f.width ?? 0) <= maxWidth &&
      f.link
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => Number(b.width ?? 0) - Number(a.width ?? 0));
  return candidates[0];
}

function slugTagsFromUrl(url: string): string {
  if (!url) return "";
  const tail = url.replace(/\/+$/, "").split("/");
  if (tail.length < 2) return "";
  let slug = tail[tail.length - 1]!;
  const parts = slug.split("-");
  if (parts.length >= 2 && /^\d+$/.test(parts[parts.length - 1]!)) slug = parts.slice(0, -1).join("-");
  return slug.replace(/-/g, " ").trim();
}

export class PexelsSource implements StockSource {
  readonly name = "pexels";
  static readonly display_name = "Pexels";
  static readonly provider = "pexels";
  static readonly priority = 10;
  static readonly install_instructions =
    "Set PEXELS_API_KEY in .env to enable Pexels stock search (free key at https://www.pexels.com/api/).";
  static readonly supports = { video: true, image: true };

  isAvailable(): boolean {
    return Boolean(process.env.PEXELS_API_KEY);
  }

  private headers(): Record<string, string> {
    const key = process.env.PEXELS_API_KEY;
    if (!key) throw new Error("PEXELS_API_KEY not set. Get a free key at https://www.pexels.com/api/ and add it to .env.");
    return { Authorization: key };
  }

  async search(query: string, filters: SearchFilters): Promise<Candidate[]> {
    const kind = (filters.kind || "video").toLowerCase();
    const out: Candidate[] = [];
    if (kind === "video" || kind === "any") out.push(...(await this.searchVideos(query, filters)));
    if (kind === "image" || kind === "any") out.push(...(await this.searchImages(query, filters)));
    return out;
  }

  private async searchVideos(query: string, filters: SearchFilters): Promise<Candidate[]> {
    const params = new URLSearchParams({
      query,
      per_page: String(Math.max(1, Math.min(filters.per_page, 80))),
      page: String(Math.max(1, filters.page)),
    });
    if (filters.orientation) params.set("orientation", filters.orientation);
    const r = await fetch(`${VIDEO_SEARCH_URL}?${params}`, { headers: this.headers() });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
    const data = (await r.json()) as { videos?: any[] };
    const out: Candidate[] = [];
    for (const v of data.videos ?? []) {
      const duration = Number(v.duration ?? 0) || 0;
      if (filters.min_duration != null && duration < filters.min_duration) continue;
      if (filters.max_duration != null && duration > filters.max_duration) continue;
      const rend = pickVideoRendition(v.video_files ?? [], filters.min_width ?? 0, 1920);
      if (!rend) continue;
      const user = v.user ?? {};
      out.push(
        new Candidate({
          source: this.name,
          source_id: String(v.id),
          source_url: v.url ?? "",
          download_url: rend.link ?? "",
          kind: "video",
          width: Number(rend.width ?? v.width ?? 0),
          height: Number(rend.height ?? v.height ?? 0),
          duration,
          creator: user.name ?? "",
          license: PEXELS_LICENSE,
          source_tags: slugTagsFromUrl(v.url ?? ""),
          thumbnail_url: v.image ?? "",
          extra: { fps: rend.fps, rendition_quality: rend.quality, user_url: user.url },
        })
      );
    }
    return out;
  }

  private async searchImages(query: string, filters: SearchFilters): Promise<Candidate[]> {
    const params = new URLSearchParams({
      query,
      per_page: String(Math.max(1, Math.min(filters.per_page, 80))),
      page: String(Math.max(1, filters.page)),
    });
    if (filters.orientation) params.set("orientation", filters.orientation);
    const r = await fetch(`${IMAGE_SEARCH_URL}?${params}`, { headers: this.headers() });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
    const data = (await r.json()) as { photos?: any[] };
    const out: Candidate[] = [];
    for (const p of data.photos ?? []) {
      const width = Number(p.width ?? 0) || 0;
      const height = Number(p.height ?? 0) || 0;
      if (filters.min_width != null && width < filters.min_width) continue;
      const src = p.src ?? {};
      const downloadUrl = src.large2x || src.original || "";
      if (!downloadUrl) continue;
      out.push(
        new Candidate({
          source: this.name,
          source_id: String(p.id),
          source_url: p.url ?? "",
          download_url: downloadUrl,
          kind: "image",
          width,
          height,
          duration: 0,
          creator: p.photographer ?? "",
          license: PEXELS_LICENSE,
          source_tags: (p.alt ?? "").trim(),
          thumbnail_url: src.medium ?? "",
          extra: { photographer_url: p.photographer_url, avg_color: p.avg_color },
        })
      );
    }
    return out;
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
