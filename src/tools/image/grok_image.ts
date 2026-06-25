/**
 * xAI Grok image generation and editing.
 *
 * TypeScript port of tools/graphics/grok_image.py. Faithful contract
 * (capability="image_generation", provider="grok", runtime API) plus a real
 * fetch translation of the Python requests flow: POST to the generations or
 * edits endpoint, then either decode an inline b64_json payload or download
 * the returned image URL(s) and write each to disk.
 *
 * Parity notes vs. Python:
 *  - Python declared dependencies=[] and overrode get_status() to check
 *    XAI_API_KEY directly. The TS port declares dependencies=["env:XAI_API_KEY"]
 *    so the base getStatus() drives preflight availability — behaviorally
 *    identical (UNAVAILABLE without the key) and keeps grok in setup_offers.
 *  - Endpoint selection (edit vs. generate), payload assembly (single `image`
 *    vs. `images` array), data-URI encoding of local paths, output-path naming,
 *    extension inference, and cost estimate all match the Python verbatim.
 */
import fs from "node:fs";
import path from "node:path";
import {
  BaseTool,
  Determinism,
  ExecutionMode,
  ResourceProfile,
  RetryPolicy,
  ToolResult,
  ToolRuntime,
  ToolStability,
  ToolTier,
  toolResult,
} from "../base_tool.js";

interface ImageInput {
  url: string;
  type: "image_url";
}

// Minimal MIME map mirroring Python's mimetypes.guess_type for the common
// image extensions; unknown types fall back to application/octet-stream.
const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".svg": "image/svg+xml",
};

function guessMimeType(name: string): string | undefined {
  return MIME_TYPES[path.extname(name).toLowerCase()];
}

function fileToDataUri(pathStr: string): string {
  if (!fs.existsSync(pathStr)) {
    throw new Error(`Input file not found: ${pathStr}`);
  }
  const mimeType = guessMimeType(path.basename(pathStr)) ?? "application/octet-stream";
  const encoded = fs.readFileSync(pathStr).toString("base64");
  return `data:${mimeType};base64,${encoded}`;
}

function normalizeImageInput(
  urlValue: string | undefined,
  pathValue: string | undefined
): ImageInput | null {
  if (urlValue) {
    return { url: urlValue, type: "image_url" };
  }
  if (pathValue) {
    return { url: fileToDataUri(pathValue), type: "image_url" };
  }
  return null;
}

export class GrokImage extends BaseTool {
  override name = "grok_image";
  override version = "0.1.0";
  override tier = ToolTier.GENERATE;
  override capability = "image_generation";
  override provider = "grok";
  override stability = ToolStability.BETA;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.STOCHASTIC;
  override runtime = ToolRuntime.API;

  override dependencies = ["env:XAI_API_KEY"];
  override install_instructions =
    "Set XAI_API_KEY to your xAI API key.\n" +
    "  Get one from the xAI developer console";
  override agent_skills = ["grok-media"];

  override capabilities = [
    "generate_image",
    "edit_image",
    "text_to_image",
    "image_to_image",
    "style_transfer",
  ];
  override supports = {
    image_edit: true,
    multiple_outputs: true,
    aspect_ratio: true,
    resolution: true,
    reference_image: true,
    multiple_reference_images: true,
  };
  override best_for = [
    "single-image edits and style transfers",
    "multi-image compositing into one generated frame",
    "general-purpose image generation with aspect ratio control",
  ];
  override not_good_for = ["offline generation", "strict seeded reproducibility"];

  override input_schema = {
    type: "object",
    required: ["prompt"],
    properties: {
      prompt: { type: "string" },
      generation_mode: {
        type: "string",
        enum: ["generate", "edit"],
        default: "generate",
        description: "Use 'edit' when providing one or more source images.",
      },
      model: {
        type: "string",
        enum: ["grok-imagine-image"],
        default: "grok-imagine-image",
      },
      aspect_ratio: { type: "string", description: "Examples: 1:1, 3:2, 16:9, 9:16" },
      resolution: {
        type: "string",
        enum: ["1k", "2k"],
        description: "xAI image output resolution tier",
      },
      n: {
        type: "integer",
        minimum: 1,
        maximum: 10,
        default: 1,
      },
      image_url: { type: "string", description: "Single source image URL for edit mode" },
      image_path: {
        type: "string",
        description: "Single local source image path for edit mode",
      },
      image_urls: {
        type: "array",
        items: { type: "string" },
        description: "Multiple source image URLs for compositing edits",
      },
      image_paths: {
        type: "array",
        items: { type: "string" },
        description: "Multiple local source image paths for compositing edits",
      },
      output_path: { type: "string" },
    },
  };

  override resource_profile: ResourceProfile = {
    cpu_cores: 1,
    ram_mb: 512,
    vram_mb: 0,
    disk_mb: 100,
    network_required: true,
  };
  override retry_policy: RetryPolicy = {
    max_retries: 2,
    backoff_seconds: 1.0,
    retryable_errors: ["rate_limit", "timeout"],
  };
  override idempotency_key_fields = [
    "prompt",
    "generation_mode",
    "model",
    "aspect_ratio",
    "resolution",
    "n",
  ];
  override side_effects = [
    "writes image file(s) to output_path",
    "calls xAI image API",
  ];
  override user_visible_verification = [
    "Inspect generated image(s) for composition quality and edit fidelity",
  ];

  private static inputImageCount(inputs: Record<string, unknown>): number {
    let count = 0;
    if (inputs.image_url || inputs.image_path) {
      count += 1;
    }
    count += ((inputs.image_urls as unknown[]) ?? []).length;
    count += ((inputs.image_paths as unknown[]) ?? []).length;
    return count;
  }

  override estimateCost(inputs: Record<string, unknown>): number {
    const outputCount = Math.trunc((inputs.n as number) ?? 1);
    const inputCount = GrokImage.inputImageCount(inputs);
    // xAI currently publishes Grok Imagine Image at $0.02 per generated
    // image plus $0.002 per input image for edits or composites.
    return outputCount * 0.02 + inputCount * 0.002;
  }

  private buildPayload(
    inputs: Record<string, unknown>
  ): [string, Record<string, unknown>] {
    let mode = (inputs.generation_mode as string) ?? "generate";
    const payload: Record<string, unknown> = {
      model: (inputs.model as string) ?? "grok-imagine-image",
      prompt: inputs.prompt,
    };
    if (inputs.aspect_ratio) payload.aspect_ratio = inputs.aspect_ratio;
    if (inputs.resolution) payload.resolution = inputs.resolution;
    if (inputs.n) payload.n = inputs.n;

    const primaryImage = normalizeImageInput(
      inputs.image_url as string | undefined,
      inputs.image_path as string | undefined
    );
    const extraImages: ImageInput[] = ((inputs.image_urls as string[]) ?? []).map(
      (url) => ({ url, type: "image_url" })
    );
    for (const p of (inputs.image_paths as string[]) ?? []) {
      extraImages.push({ url: fileToDataUri(p), type: "image_url" });
    }

    if (primaryImage || extraImages.length > 0) {
      mode = "edit";
    }

    let endpoint: string;
    if (mode === "edit") {
      endpoint = "https://api.x.ai/v1/images/edits";
      if (primaryImage && extraImages.length === 0) {
        payload.image = primaryImage;
      } else {
        const images: ImageInput[] = [];
        if (primaryImage) images.push(primaryImage);
        images.push(...extraImages);
        if (images.length === 0) {
          throw new Error(
            "Edit mode requires image_url/image_path or image_urls/image_paths"
          );
        }
        payload.images = images;
      }
    } else {
      endpoint = "https://api.x.ai/v1/images/generations";
    }

    return [endpoint, payload];
  }

  private static inferExtension(url: string): string {
    let pathname: string;
    try {
      pathname = new URL(url).pathname;
    } catch {
      pathname = url;
    }
    const suffix = path.extname(pathname).toLowerCase();
    if ([".png", ".jpg", ".jpeg", ".webp"].includes(suffix)) {
      return suffix;
    }
    return ".png";
  }

  private static outputPaths(
    outputPath: string | undefined,
    count: number,
    extension: string
  ): string[] {
    if (!outputPath) {
      const stem = "grok_image";
      return Array.from({ length: count }, (_, idx) => `${stem}_${idx + 1}${extension}`);
    }

    const suffix = path.extname(outputPath) || extension;
    if (count === 1) {
      return [
        path.extname(outputPath)
          ? outputPath
          : `${outputPath}${suffix}`,
      ];
    }

    // base = path without its suffix (mirrors Path.with_suffix("") / bare stem).
    const dir = path.dirname(outputPath);
    const ext = path.extname(outputPath);
    const baseName = ext ? path.basename(outputPath, ext) : path.basename(outputPath);
    return Array.from({ length: count }, (_, idx) =>
      path.join(dir, `${baseName}_${idx + 1}${suffix}`)
    );
  }

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) {
      return toolResult({
        success: false,
        error: "XAI_API_KEY not set. " + this.install_instructions,
      });
    }

    const start = Date.now();
    let payload: Record<string, unknown>;
    const artifacts: string[] = [];
    const outputs: string[] = [];
    try {
      const [endpoint, builtPayload] = this.buildPayload(inputs);
      payload = builtPayload;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status} ${response.statusText}: ${body}`);
      }
      const data = (await response.json()) as {
        data?: Array<{ url?: string; b64_json?: string }>;
      };

      const items = data.data ?? [];
      if (items.length === 0) {
        return toolResult({
          success: false,
          error: "xAI returned no image outputs",
        });
      }

      let extension = ".png";
      const firstUrl = items[0]!.url;
      if (firstUrl) {
        extension = GrokImage.inferExtension(firstUrl);
      }

      const outputPaths = GrokImage.outputPaths(
        inputs.output_path as string | undefined,
        items.length,
        extension
      );

      for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        const outputPath = outputPaths[i]!;
        // Mirror Python's output_path.parent.mkdir(parents=True, exist_ok=True);
        // dirname of a bare filename is "." (a no-op), matching Path(".").
        fs.mkdirSync(path.dirname(outputPath) || ".", { recursive: true });
        if (item.b64_json) {
          fs.writeFileSync(outputPath, Buffer.from(item.b64_json, "base64"));
        } else {
          const imageUrl = item.url;
          if (!imageUrl) {
            return toolResult({
              success: false,
              error: "xAI image output missing url",
            });
          }
          const download = await fetch(imageUrl);
          if (!download.ok) {
            throw new Error(
              `HTTP ${download.status} ${download.statusText} downloading ${imageUrl}`
            );
          }
          fs.writeFileSync(outputPath, Buffer.from(await download.arrayBuffer()));
        }
        artifacts.push(outputPath);
        outputs.push(outputPath);
      }
    } catch (e) {
      return toolResult({
        success: false,
        error: `Grok image generation failed: ${(e as Error).message ?? e}`,
      });
    }

    const primaryOutput = outputs[0]!;
    return toolResult({
      success: true,
      data: {
        provider: "grok",
        model: payload.model,
        prompt: inputs.prompt,
        generation_mode: (inputs.generation_mode as string) ?? "generate",
        output: primaryOutput,
        outputs,
        images_generated: outputs.length,
      },
      artifacts,
      cost_usd: this.estimateCost(inputs),
      duration_seconds: Math.round((Date.now() - start) / 10) / 100,
      model: payload.model as string,
    });
  }
}
