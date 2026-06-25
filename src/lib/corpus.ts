/**
 * Local clip corpus (TS port of lib/corpus.py).
 *
 * Append-only project-scoped index of candidate video/image assets with vector
 * search. numpy → plain JS arrays + dot products (corpora are a few hundred rows,
 * so no FAISS needed). Embeddings persist as .npy (float32) for compatibility with
 * the documented corpus layout; a minimal reader/writer handles the '<f4' 2D case.
 */
import fs from "node:fs";
import path from "node:path";

export const EMBED_DIM = 512;

export interface ClipRecord {
  clip_id: string;
  source: string;
  source_id: string;
  source_url: string;
  local_path: string;
  kind: string;
  thumb_dir: string;
  query: string;
  creator: string;
  license: string;
  duration: number;
  width: number;
  height: number;
  motion_score: number;
  dominant_colors: number[][];
  source_tags: string;
  shot_type: string;
  time_of_day: string;
  added_at: number;
}

export function makeClipRecord(partial: Partial<ClipRecord> & { clip_id: string; source: string; source_id: string; source_url: string; local_path: string }): ClipRecord {
  return {
    kind: "video",
    thumb_dir: "",
    query: "",
    creator: "",
    license: "",
    duration: 0,
    width: 0,
    height: 0,
    motion_score: 0,
    dominant_colors: [],
    source_tags: "",
    shot_type: "",
    time_of_day: "",
    added_at: 0,
    ...partial,
  } as ClipRecord;
}

// --- minimal .npy (float32, 2D, C-order) read/write ---
function writeNpyFloat32(filePath: string, rows: number[][]): void {
  const n = rows.length;
  const cols = n > 0 ? rows[0]!.length : EMBED_DIM;
  let header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${n}, ${cols}), }`;
  const baseLen = 10 + header.length + 1; // magic(6)+ver(2)+hlen(2) + header + '\n'
  const pad = (64 - (baseLen % 64)) % 64;
  header += " ".repeat(pad) + "\n";
  const headBuf = Buffer.alloc(10 + header.length);
  headBuf.write("\x93NUMPY", 0, "latin1");
  headBuf[6] = 1;
  headBuf[7] = 0;
  headBuf.writeUInt16LE(header.length, 8);
  headBuf.write(header, 10, "latin1");
  const data = Buffer.alloc(n * cols * 4);
  let off = 0;
  for (const row of rows) for (const v of row) {
    data.writeFloatLE(v, off);
    off += 4;
  }
  fs.writeFileSync(filePath, Buffer.concat([headBuf, data]));
}

function readNpyFloat32(filePath: string): number[][] {
  const buf = fs.readFileSync(filePath);
  const headerLen = buf.readUInt16LE(8);
  const header = buf.toString("latin1", 10, 10 + headerLen);
  const shapeMatch = header.match(/'shape':\s*\((\d+),\s*(\d+)\)/);
  if (!shapeMatch) return [];
  const n = Number(shapeMatch[1]);
  const cols = Number(shapeMatch[2]);
  const dataStart = 10 + headerLen;
  const rows: number[][] = [];
  let off = dataStart;
  for (let i = 0; i < n; i += 1) {
    const row = new Array<number>(cols);
    for (let j = 0; j < cols; j += 1) {
      row[j] = buf.readFloatLE(off);
      off += 4;
    }
    rows.push(row);
  }
  return rows;
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i]! * b[i]!;
  return s;
}

export class Corpus {
  corpusDir: string;
  records: ClipRecord[] = [];
  clipEmbeddings: number[][] = [];
  tagEmbeddings: number[][] = [];
  private idToRow = new Map<string, number>();

  constructor(corpusDir: string) {
    this.corpusDir = corpusDir;
  }

  get clipsDir(): string {
    return path.join(this.corpusDir, "clips");
  }
  get thumbsDir(): string {
    return path.join(this.corpusDir, "thumbnails");
  }
  get indexPath(): string {
    return path.join(this.corpusDir, "index.jsonl");
  }
  get embedPath(): string {
    return path.join(this.corpusDir, "embeddings.npy");
  }
  get tagEmbedPath(): string {
    return path.join(this.corpusDir, "tag_embeddings.npy");
  }

  ensureDirs(): void {
    fs.mkdirSync(this.corpusDir, { recursive: true });
    fs.mkdirSync(this.clipsDir, { recursive: true });
    fs.mkdirSync(this.thumbsDir, { recursive: true });
  }

  load(): void {
    this.records = [];
    this.idToRow = new Map();
    if (fs.existsSync(this.indexPath)) {
      const lines = fs.readFileSync(this.indexPath, "utf-8").split("\n");
      let i = 0;
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        const rec = makeClipRecord(JSON.parse(t));
        this.records.push(rec);
        this.idToRow.set(rec.clip_id, i);
        i += 1;
      }
    }
    this.clipEmbeddings = fs.existsSync(this.embedPath) ? readNpyFloat32(this.embedPath) : [];
    this.tagEmbeddings = fs.existsSync(this.tagEmbedPath) ? readNpyFloat32(this.tagEmbedPath) : [];

    // Truncate to the shortest length if JSONL/.npy drifted (crash mid-add).
    const n = Math.min(this.records.length, this.clipEmbeddings.length, this.tagEmbeddings.length);
    if (n !== this.records.length) {
      this.records = this.records.slice(0, n);
      this.idToRow = new Map(this.records.map((r, i) => [r.clip_id, i]));
    }
    if (this.clipEmbeddings.length !== n) this.clipEmbeddings = this.clipEmbeddings.slice(0, n);
    if (this.tagEmbeddings.length !== n) this.tagEmbeddings = this.tagEmbeddings.slice(0, n);
  }

  save(): void {
    this.ensureDirs();
    const tmp = this.indexPath + ".tmp";
    fs.writeFileSync(tmp, this.records.map((r) => JSON.stringify(r)).join("\n") + (this.records.length ? "\n" : ""), "utf-8");
    fs.renameSync(tmp, this.indexPath);
    writeNpyFloat32(this.embedPath, this.clipEmbeddings);
    writeNpyFloat32(this.tagEmbedPath, this.tagEmbeddings);
  }

  has(clipId: string): boolean {
    return this.idToRow.has(clipId);
  }

  add(record: ClipRecord, clipEmbedding: number[], tagEmbedding: number[]): void {
    if (this.idToRow.has(record.clip_id)) return;
    if (clipEmbedding.length !== EMBED_DIM) throw new Error(`clip_embedding must be (${EMBED_DIM},), got ${clipEmbedding.length}`);
    if (tagEmbedding.length !== EMBED_DIM) throw new Error(`tag_embedding must be (${EMBED_DIM},), got ${tagEmbedding.length}`);
    if (record.added_at === 0) record.added_at = Date.now() / 1000;
    const idx = this.records.length;
    this.records.push(record);
    this.idToRow.set(record.clip_id, idx);
    this.clipEmbeddings.push(clipEmbedding);
    this.tagEmbeddings.push(tagEmbedding);
  }

  get(clipId: string): ClipRecord | null {
    const idx = this.idToRow.get(clipId);
    return idx === undefined ? null : this.records[idx]!;
  }

  get length(): number {
    return this.records.length;
  }

  private fusedSims(queryVec: number[], tagWeight: number): number[] {
    if (this.clipEmbeddings.length === 0) return [];
    return this.clipEmbeddings.map((v, i) => (1 - tagWeight) * dot(v, queryVec) + tagWeight * dot(this.tagEmbeddings[i]!, queryVec));
  }

  rankByText(
    queryEmbedding: number[],
    opts: { k?: number; tagWeight?: number; motionMin?: number | null; kind?: string | null; excludeIds?: string[] } = {}
  ): Array<[ClipRecord, number]> {
    if (this.records.length === 0) return [];
    const { k = 20, tagWeight = 0.3, motionMin = null, kind = null, excludeIds = [] } = opts;
    const scores = this.fusedSims(queryEmbedding, tagWeight);
    const exclude = new Set(excludeIds);
    const ranked: Array<[number, number]> = [];
    for (let i = 0; i < scores.length; i += 1) {
      const rec = this.records[i]!;
      if (exclude.has(rec.clip_id)) continue;
      if (kind && rec.kind !== kind) continue;
      if (motionMin !== null && rec.motion_score < motionMin) continue;
      ranked.push([i, scores[i]!]);
    }
    ranked.sort((a, b) => b[1] - a[1]);
    return ranked.slice(0, k).map(([i, s]) => [this.records[i]!, s]);
  }

  knn(clipId: string, k = 5, excludeIds: string[] = []): Array<[ClipRecord, number]> {
    const seedIdx = this.idToRow.get(clipId);
    if (seedIdx === undefined) return [];
    const seedVec = this.clipEmbeddings[seedIdx]!;
    const exclude = new Set(excludeIds);
    exclude.add(clipId);
    const ranked: Array<[number, number]> = [];
    for (let i = 0; i < this.clipEmbeddings.length; i += 1) {
      if (exclude.has(this.records[i]!.clip_id)) continue;
      ranked.push([i, dot(this.clipEmbeddings[i]!, seedVec)]);
    }
    ranked.sort((a, b) => b[1] - a[1]);
    return ranked.slice(0, k).map(([i, s]) => [this.records[i]!, s]);
  }

  findSimilarSet(
    seedClipId: string,
    opts: { n?: number; diversity?: number; candidatePool?: number; excludeIds?: string[] } = {}
  ): Array<[ClipRecord, number]> {
    const seedIdx = this.idToRow.get(seedClipId);
    if (seedIdx === undefined) return [];
    const { n = 5, diversity = 0.3, candidatePool = 30, excludeIds = [] } = opts;
    const seedVec = this.clipEmbeddings[seedIdx]!;
    const exclude = new Set(excludeIds);
    exclude.add(seedClipId);

    const simsToSeed = this.clipEmbeddings.map((v) => dot(v, seedVec));
    const order = simsToSeed.map((s, i) => [i, s] as [number, number]).sort((a, b) => b[1] - a[1]);
    const pool: number[] = [];
    for (const [i] of order) {
      if (exclude.has(this.records[i]!.clip_id)) continue;
      pool.push(i);
      if (pool.length >= candidatePool) break;
    }
    if (pool.length === 0) return [];

    const picked: number[] = [];
    const pickedScores: number[] = [];
    while (pool.length > 0 && picked.length < n) {
      let bestI = -1;
      let bestScore = -1e9;
      for (const i of pool) {
        const simSeed = simsToSeed[i]!;
        let simPicked = 0;
        for (const p of picked) simPicked = Math.max(simPicked, dot(this.clipEmbeddings[i]!, this.clipEmbeddings[p]!));
        const mmr = (1 - diversity) * simSeed - diversity * simPicked;
        if (mmr > bestScore) {
          bestScore = mmr;
          bestI = i;
        }
      }
      picked.push(bestI);
      pickedScores.push(bestScore);
      pool.splice(pool.indexOf(bestI), 1);
    }
    return picked.map((i, idx) => [this.records[i]!, pickedScores[idx]!]);
  }

  diversify(candidateIds: string[], n: number, diversity = 0.5): string[] {
    if (candidateIds.length === 0) return [];
    const idxs = candidateIds.map((c) => this.idToRow.get(c)).filter((x): x is number => x !== undefined);
    if (idxs.length === 0) return [];
    const picked: number[] = [idxs[0]!];
    const remaining = idxs.slice(1);
    while (remaining.length > 0 && picked.length < n) {
      let bestI = -1;
      let bestScore = -1e9;
      for (let ri = 0; ri < remaining.length; ri += 1) {
        const i = remaining[ri]!;
        let simPicked = 0;
        for (const p of picked) simPicked = Math.max(simPicked, dot(this.clipEmbeddings[i]!, this.clipEmbeddings[p]!));
        let score = -simPicked;
        score = diversity * score + (1 - diversity) * -ri;
        if (score > bestScore) {
          bestScore = score;
          bestI = i;
        }
      }
      picked.push(bestI);
      remaining.splice(remaining.indexOf(bestI), 1);
    }
    return picked.map((i) => this.records[i]!.clip_id);
  }
}
