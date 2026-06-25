/**
 * Unified protocol for stock media source adapters (TS port of
 * tools/video/stock_sources/base.py). Every source (Pexels, Archive.org, NASA,
 * Wikimedia, Unsplash, ...) implements the same small interface so the clip tools
 * can fan out without branching on source type. search()/download() are async
 * (network) in the TS port.
 */
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Stream an HTTP download to a file (shared by adapters). Mirrors requests stream=True. */
export async function streamDownload(url: string, outPath: string, headers?: Record<string, string>): Promise<string> {
  if (!url) throw new Error("no download_url");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const r = await fetch(url, headers ? { headers } : {});
  if (!r.ok || !r.body) throw new Error(`download HTTP ${r.status}`);
  await pipeline(Readable.fromWeb(r.body as Parameters<typeof Readable.fromWeb>[0]), fs.createWriteStream(outPath));
  return outPath;
}

/** Deterministic 8-hex id (FNV-1a), TS stand-in for Python `hash(x) & 0xFFFFFFFF`. */
export function hashId(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export interface SearchFilters {
  kind: string; // "video" | "image" | "any"
  min_duration?: number | null;
  max_duration?: number | null;
  orientation?: string | null; // "landscape" | "portrait" | "square"
  min_width?: number | null;
  per_page: number;
  page: number;
}

export function makeSearchFilters(partial: Partial<SearchFilters> = {}): SearchFilters {
  return { kind: "video", min_duration: null, max_duration: null, orientation: null, min_width: null, per_page: 20, page: 1, ...partial };
}

/** One pre-download search result, normalised across sources. */
export class Candidate {
  source: string;
  source_id: string;
  source_url: string;
  download_url: string;
  kind: string;
  width: number;
  height: number;
  duration: number;
  creator: string;
  license: string;
  source_tags: string;
  thumbnail_url: string;
  extra: Record<string, unknown>;

  constructor(args: {
    source: string;
    source_id: string;
    source_url: string;
    download_url: string;
    kind: string;
    width?: number;
    height?: number;
    duration?: number;
    creator?: string;
    license?: string;
    source_tags?: string;
    thumbnail_url?: string;
    extra?: Record<string, unknown>;
  }) {
    this.source = args.source;
    this.source_id = args.source_id;
    this.source_url = args.source_url;
    this.download_url = args.download_url;
    this.kind = args.kind;
    this.width = args.width ?? 0;
    this.height = args.height ?? 0;
    this.duration = args.duration ?? 0;
    this.creator = args.creator ?? "";
    this.license = args.license ?? "";
    this.source_tags = args.source_tags ?? "";
    this.thumbnail_url = args.thumbnail_url ?? "";
    this.extra = args.extra ?? {};
  }

  /** Stable corpus row key: "<source>_<source_id>". */
  get clip_id(): string {
    return `${this.source}_${this.source_id}`;
  }
}

/** Protocol every stock source adapter must satisfy. */
export interface StockSource {
  readonly name: string;
  isAvailable(): boolean;
  search(query: string, filters: SearchFilters): Promise<Candidate[]>;
  download(candidate: Candidate, outPath: string): Promise<string>;
}

/** Optional discoverability metadata an adapter class may expose (static). */
export interface StockSourceMeta {
  display_name?: string;
  provider?: string;
  install_instructions?: string;
  supports?: Record<string, unknown>;
  priority?: number;
}
