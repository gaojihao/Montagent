/**
 * CLIP embedder (TS port of lib/clip_embedder.py).
 *
 * Turns images and text into L2-normalised 512-d vectors (number[]) for cosine
 * comparison. Python used torch + transformers (openai/clip-vit-base-patch32);
 * the TS port uses @xenova/transformers (Xenova/clip-vit-base-patch32, ONNX/CPU,
 * no torch). Models lazy-load once per process. Vectors are L2-normalised so
 * cosine similarity is a plain dot product downstream.
 */
const MODEL_ID = "Xenova/clip-vit-base-patch32";

let _textBundle: Promise<{ tokenizer: any; model: any }> | null = null;
let _imageBundle: Promise<{ processor: any; model: any; RawImage: any }> | null = null;

async function loadTransformers(): Promise<any> {
  const specifier = "@xenova/transformers";
  return import(specifier);
}

function l2normalizeRows(rows: number[][]): number[][] {
  return rows.map((row) => {
    let norm = 0;
    for (const v of row) norm += v * v;
    norm = Math.sqrt(norm);
    if (norm < 1e-8) return row.map(() => 0);
    return row.map((v) => v / norm);
  });
}

export function modelInfo(): { model_id: string; device: string; dim: number } {
  return { model_id: MODEL_ID, device: "cpu", dim: 512 };
}

/** Embed text strings into L2-normalised 512-d vectors. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (!_textBundle) {
    _textBundle = (async () => {
      const t = await loadTransformers();
      const tokenizer = await t.AutoTokenizer.from_pretrained(MODEL_ID);
      const model = await t.CLIPTextModelWithProjection.from_pretrained(MODEL_ID);
      return { tokenizer, model };
    })();
  }
  const { tokenizer, model } = await _textBundle;
  // Empty strings break the tokenizer; substitute a placeholder (matches Python).
  const safe = texts.map((x) => (x && x.trim() ? x : "untitled"));
  const inputs = tokenizer(safe, { padding: true, truncation: true });
  const { text_embeds } = await model(inputs);
  return l2normalizeRows(text_embeds.tolist() as number[][]);
}

/** Embed image files into L2-normalised 512-d vectors. */
export async function embedImages(imagePaths: string[]): Promise<number[][]> {
  if (imagePaths.length === 0) return [];
  if (!_imageBundle) {
    _imageBundle = (async () => {
      const t = await loadTransformers();
      const processor = await t.AutoProcessor.from_pretrained(MODEL_ID);
      const model = await t.CLIPVisionModelWithProjection.from_pretrained(MODEL_ID);
      return { processor, model, RawImage: t.RawImage };
    })();
  }
  const { processor, model, RawImage } = await _imageBundle;
  const out: number[][] = [];
  for (const p of imagePaths) {
    const image = await RawImage.read(p);
    const inputs = await processor(image);
    const { image_embeds } = await model(inputs);
    out.push(...(image_embeds.tolist() as number[][]));
  }
  return l2normalizeRows(out);
}

/** Average a stack of frame embeddings into one clip vector, renormalised. */
export function poolFrames(frameEmbeddings: number[][]): number[] {
  if (frameEmbeddings.length === 0) return new Array(512).fill(0);
  const dim = frameEmbeddings[0]!.length;
  const mean = new Array(dim).fill(0);
  for (const row of frameEmbeddings) for (let i = 0; i < dim; i += 1) mean[i] += row[i]!;
  for (let i = 0; i < dim; i += 1) mean[i] /= frameEmbeddings.length;
  let norm = 0;
  for (const v of mean) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm < 1e-8) return new Array(dim).fill(0);
  return mean.map((v) => v / norm);
}
