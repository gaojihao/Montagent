/**
 * Shared clip bytes cache for the corpus builder (TS port of tools/video/clip_cache.py).
 * Process-safe (O_EXCL lock), LRU-evicted cache at ~/.montagent/clips_cache/.
 * Hard-links (or copies cross-drive) cached blobs into a corpus dir to skip re-downloads.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_MAX_TOTAL_BYTES = 20 * 1024 * 1024 * 1024; // 20 GB
const MIN_USABLE_BYTES = 1024;

export function defaultCacheDir(): string {
  const override = process.env.MONTAGENT_CACHE_DIR;
  if (override) return override.replace(/^~(?=$|\/)/, os.homedir());
  return path.join(os.homedir(), ".montagent", "clips_cache");
}

export function defaultMaxTotalBytes(): number {
  const override = process.env.MONTAGENT_CACHE_MAX_GB;
  if (override) {
    const v = parseFloat(override);
    if (!Number.isNaN(v)) return Math.trunc(v * 1024 * 1024 * 1024);
  }
  return DEFAULT_MAX_TOTAL_BYTES;
}

interface CacheEntry {
  clip_id: string;
  file_name: string;
  size_bytes: number;
  added_at: number;
  last_access_at: number;
  source: string;
  source_id: string;
  source_url: string;
  license: string;
  creator: string;
  source_tags: string;
}

function linkOrCopy(src: string, dst: string): boolean {
  try {
    fs.linkSync(src, dst);
    return true;
  } catch {
    /* cross-drive / unsupported → copy */
  }
  try {
    fs.copyFileSync(src, dst);
    return true;
  } catch {
    return false;
  }
}

export class ClipCache {
  cacheDir: string;
  maxTotalBytes: number;
  hits = 0;
  misses = 0;
  evictionsCount = 0;
  bytesEvicted = 0;
  private lockPath: string;
  private manifestPath: string;

  constructor(cacheDir?: string, maxTotalBytes?: number) {
    this.cacheDir = cacheDir ?? defaultCacheDir();
    this.maxTotalBytes = maxTotalBytes ?? defaultMaxTotalBytes();
    fs.mkdirSync(this.cacheDir, { recursive: true });
    this.manifestPath = path.join(this.cacheDir, "cache_manifest.jsonl");
    this.lockPath = path.join(this.cacheDir, "cache_manifest.lock");
  }

  private withLock<T>(fn: () => T, timeout = 60): T {
    const deadline = Date.now() + timeout * 1000;
    let fd: number | null = null;
    while (Date.now() < deadline) {
      try {
        fd = fs.openSync(this.lockPath, "wx");
        break;
      } catch {
        // busy-wait briefly (Atomics-based sleep keeps it synchronous)
        const sab = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(sab, 0, 0, 50);
      }
    }
    if (fd === null) throw new Error(`ClipCache: could not acquire lock at ${this.lockPath} after ${timeout}s`);
    try {
      return fn();
    } finally {
      try {
        fs.closeSync(fd);
        fs.unlinkSync(this.lockPath);
      } catch {
        /* ignore */
      }
    }
  }

  private readManifest(): Map<string, CacheEntry> {
    const entries = new Map<string, CacheEntry>();
    if (!fs.existsSync(this.manifestPath)) return entries;
    try {
      for (const line of fs.readFileSync(this.manifestPath, "utf-8").split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const e = JSON.parse(t) as CacheEntry;
          if (e.clip_id) entries.set(e.clip_id, e);
        } catch {
          /* skip malformed line */
        }
      }
    } catch {
      return new Map();
    }
    return entries;
  }

  private writeManifest(entries: Map<string, CacheEntry>): void {
    const tmp = path.join(this.cacheDir, `cache_manifest.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, [...entries.values()].map((e) => JSON.stringify(e)).join("\n") + (entries.size ? "\n" : ""), "utf-8");
    fs.renameSync(tmp, this.manifestPath);
  }

  tryLink(clipId: string, dest: string): boolean {
    return this.withLock(() => {
      const entries = this.readManifest();
      const entry = entries.get(clipId);
      if (!entry) {
        this.misses += 1;
        return false;
      }
      const blobPath = path.join(this.cacheDir, entry.file_name);
      if (!fs.existsSync(blobPath)) {
        entries.delete(clipId);
        this.writeManifest(entries);
        this.misses += 1;
        return false;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      try {
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
      } catch {
        /* ignore */
      }
      if (!linkOrCopy(blobPath, dest)) {
        this.misses += 1;
        return false;
      }
      entry.last_access_at = Date.now() / 1000;
      entries.set(clipId, entry);
      this.writeManifest(entries);
      this.hits += 1;
      return true;
    });
  }

  ingest(clipId: string, sourcePath: string, metadata: Record<string, any> = {}): boolean {
    if (!fs.existsSync(sourcePath)) return false;
    let sizeBytes: number;
    try {
      sizeBytes = fs.statSync(sourcePath).size;
    } catch {
      return false;
    }
    if (sizeBytes < MIN_USABLE_BYTES) return false;
    return this.withLock(() => {
      const entries = this.readManifest();
      const existing = entries.get(clipId);
      if (existing && fs.existsSync(path.join(this.cacheDir, existing.file_name))) {
        existing.last_access_at = Date.now() / 1000;
        this.writeManifest(entries);
        return true;
      }
      this.evictToFit(entries, sizeBytes);
      const ext = path.extname(sourcePath) || "";
      const blobName = `${clipId}${ext}`;
      const blobPath = path.join(this.cacheDir, blobName);
      if (fs.existsSync(blobPath)) {
        try {
          fs.unlinkSync(blobPath);
        } catch {
          return false;
        }
      }
      if (!linkOrCopy(sourcePath, blobPath)) return false;
      const now = Date.now() / 1000;
      entries.set(clipId, {
        clip_id: clipId,
        file_name: blobName,
        size_bytes: sizeBytes,
        added_at: now,
        last_access_at: now,
        source: String(metadata.source ?? ""),
        source_id: String(metadata.source_id ?? ""),
        source_url: String(metadata.source_url ?? ""),
        license: String(metadata.license ?? ""),
        creator: String(metadata.creator ?? ""),
        source_tags: String(metadata.source_tags ?? ""),
      });
      this.writeManifest(entries);
      return true;
    });
  }

  stats(): Record<string, any> {
    const entries = this.withLock(() => this.readManifest());
    const totalBytes = [...entries.values()].reduce((a, e) => a + e.size_bytes, 0);
    return {
      cache_dir: this.cacheDir,
      entry_count: entries.size,
      total_bytes: totalBytes,
      total_mb: Math.round((totalBytes / (1024 * 1024)) * 10) / 10,
      max_total_bytes: this.maxTotalBytes,
      max_total_gb: Math.round((this.maxTotalBytes / 1024 ** 3) * 100) / 100,
      usage_fraction: this.maxTotalBytes > 0 ? Math.round((totalBytes / this.maxTotalBytes) * 1000) / 1000 : 0.0,
      hits_this_session: this.hits,
      misses_this_session: this.misses,
      evictions_this_session: this.evictionsCount,
      bytes_evicted_this_session: this.bytesEvicted,
      filelock_backend: "o_excl_fallback",
    };
  }

  private evictToFit(entries: Map<string, CacheEntry>, neededBytes: number): void {
    if (neededBytes <= 0) return;
    let current = [...entries.values()].reduce((a, e) => a + e.size_bytes, 0);
    if (current + neededBytes <= this.maxTotalBytes) return;
    const victims = [...entries.values()].sort((a, b) => a.last_access_at - b.last_access_at);
    for (const victim of victims) {
      if (current + neededBytes <= this.maxTotalBytes) break;
      const blobPath = path.join(this.cacheDir, victim.file_name);
      try {
        if (fs.existsSync(blobPath)) fs.unlinkSync(blobPath);
      } catch {
        continue;
      }
      current -= victim.size_bytes;
      entries.delete(victim.clip_id);
      this.evictionsCount += 1;
      this.bytesEvicted += victim.size_bytes;
    }
  }
}

let _DEFAULT_CACHE: ClipCache | null = null;
export function getDefaultCache(): ClipCache {
  if (_DEFAULT_CACHE === null) _DEFAULT_CACHE = new ClipCache();
  return _DEFAULT_CACHE;
}
export function resetDefaultCache(): void {
  _DEFAULT_CACHE = null;
}
