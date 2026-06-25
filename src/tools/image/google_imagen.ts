/**
 * Google Imagen image generation via Gemini API / Vertex AI (TS port of
 * tools/graphics/google_imagen.py). requests -> fetch; google-auth -> the shared
 * node:crypto JWT-bearer flow in ../google_credentials.js.
 */
import fs from "node:fs";
import path from "node:path";
import {
  BaseTool,
  Determinism,
  ExecutionMode,
  type ResourceProfile,
  type RetryPolicy,
  type ToolResult,
  ToolRuntime,
  ToolStability,
  ToolStatus,
  ToolTier,
  toolResult,
} from "../base_tool.js";
import { getAccessToken, resolveProjectId, serviceAccountConfigured } from "../google_credentials.js";

// Aspect ratio to approximate pixel dimensions (for cost/reporting only)
const ASPECT_RATIOS: Record<string, [number, number]> = {
  "1:1": [1024, 1024],
  "3:4": [896, 1152],
  "4:3": [1152, 896],
  "9:16": [768, 1344],
  "16:9": [1344, 768],
};

function dimsToAspectRatio(width: number, height: number): string {
  const target = width / height;
  let best = "1:1";
  let bestDiff = Infinity;
  for (const [ratio, [w, h]] of Object.entries(ASPECT_RATIOS)) {
    const diff = Math.abs(target - w / h);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = ratio;
    }
  }
  return best;
}

export class GoogleImagen extends BaseTool {
  override name = "google_imagen";
  override version = "0.1.0";
  override tier = ToolTier.GENERATE;
  override capability = "image_generation";
  override provider = "google_imagen";
  override stability = ToolStability.BETA;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.STOCHASTIC;
  override runtime = ToolRuntime.API;

  override dependencies: string[] = []; // checked dynamically via env var / service account
  override install_instructions =
    "Auth option A — API key (AI Studio): set GOOGLE_API_KEY (or GEMINI_API_KEY).\n" +
    "  Get one at https://aistudio.google.com/apikey\n" +
    "Auth option B — service account (Vertex AI): set GOOGLE_APPLICATION_CREDENTIALS\n" +
    "  to a service-account JSON key, plus GOOGLE_CLOUD_PROJECT and optionally\n" +
    "  GOOGLE_CLOUD_LOCATION (default us-central1). Requires the Vertex AI API enabled.";
  override agent_skills: string[] = [];

  override capabilities = ["generate_image", "generate_illustration", "text_to_image"];
  override supports = {
    negative_prompt: false,
    seed: false,
    custom_size: false,
    aspect_ratio: true,
  };
  override best_for = [
    "high-quality photorealistic images",
    "Google ecosystem integration",
    "fast generation with multiple aspect ratios",
  ];
  override not_good_for = [
    "negative prompt control (not supported)",
    "exact pixel dimensions (uses aspect ratios)",
    "offline generation",
  ];

  override input_schema = {
    type: "object",
    required: ["prompt"],
    properties: {
      prompt: { type: "string", description: "Image description (max 480 tokens)" },
      aspect_ratio: {
        type: "string",
        enum: ["1:1", "3:4", "4:3", "9:16", "16:9"],
        default: "1:1",
        description: "Aspect ratio of generated image",
      },
      width: { type: "integer", description: "Desired width in pixels — mapped to nearest aspect ratio" },
      height: { type: "integer", description: "Desired height in pixels — mapped to nearest aspect ratio" },
      model: {
        type: "string",
        enum: ["imagen-4.0-generate-001", "imagen-4.0-fast-generate-001", "imagen-4.0-ultra-generate-001"],
        default: "imagen-4.0-generate-001",
        description: "Imagen model variant",
      },
      number_of_images: { type: "integer", default: 1, minimum: 1, maximum: 4 },
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
  override retry_policy: RetryPolicy = { max_retries: 2, backoff_seconds: 1.0, retryable_errors: ["rate_limit", "timeout"] };
  override idempotency_key_fields = ["prompt", "aspect_ratio", "model"];
  override side_effects = ["writes image file to output_path", "calls Google Generative AI API"];
  override user_visible_verification = ["Inspect generated image for relevance and quality"];

  private getApiKey(): string | undefined {
    return process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  }

  override getStatus(): ToolStatus {
    // API key -> AI Studio endpoint; service-account JSON -> Vertex AI.
    if (this.getApiKey() || serviceAccountConfigured()) return ToolStatus.AVAILABLE;
    return ToolStatus.UNAVAILABLE;
  }

  override estimateCost(inputs: Record<string, unknown>): number {
    const model = (inputs.model as string) ?? "imagen-4.0-generate-001";
    const n = (inputs.number_of_images as number) ?? 1;
    if (model.includes("ultra")) return 0.06 * n;
    if (model.includes("fast")) return 0.02 * n;
    return 0.04 * n;
  }

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const apiKey = this.getApiKey();
    let bearerToken: string | undefined;
    let projectId: string | undefined;
    if (!apiKey) {
      if (!serviceAccountConfigured()) {
        return toolResult({ success: false, error: "No Google credentials found. " + this.install_instructions });
      }
      try {
        const [token, credsProject] = await getAccessToken();
        bearerToken = token;
        projectId = resolveProjectId(credsProject);
      } catch (exc) {
        return toolResult({ success: false, error: (exc as Error).message });
      }
      if (!projectId) {
        return toolResult({
          success: false,
          error:
            "Vertex AI needs a project id. Set GOOGLE_CLOUD_PROJECT " +
            "(or include project_id in the service-account key).",
        });
      }
    }

    const start = Date.now();
    const model = (inputs.model as string) ?? "imagen-4.0-generate-001";
    const prompt = inputs.prompt as string;

    let aspectRatio: string;
    if ("aspect_ratio" in inputs) aspectRatio = inputs.aspect_ratio as string;
    else if ("width" in inputs && "height" in inputs)
      aspectRatio = dimsToAspectRatio(inputs.width as number, inputs.height as number);
    else aspectRatio = "1:1";

    const numberOfImages = (inputs.number_of_images as number) ?? 1;
    const parameters = { sampleCount: numberOfImages, aspectRatio };

    let url: string;
    let headers: Record<string, string>;
    if (bearerToken) {
      const location = process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1";
      url =
        `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}` +
        `/locations/${location}/publishers/google/models/${model}:predict`;
      headers = { "Content-Type": "application/json", Authorization: `Bearer ${bearerToken}` };
    } else {
      url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict`;
      headers = { "Content-Type": "application/json", "x-goog-api-key": apiKey as string };
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ instances: [{ prompt }], parameters }),
        signal: AbortSignal.timeout(120000),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status} ${response.statusText}: ${body}`);
      }
      const data = (await response.json()) as { predictions?: Array<{ bytesBase64Encoded: string }> };
      const predictions = data.predictions ?? [];
      if (predictions.length === 0) {
        return toolResult({ success: false, error: "No images returned from Imagen API" });
      }
      const imageBytes = Buffer.from(predictions[0]!.bytesBase64Encoded, "base64");
      const outputPath = path.resolve((inputs.output_path as string) ?? "generated_image.png");
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, imageBytes);

      return toolResult({
        success: true,
        data: {
          provider: "google_imagen",
          model,
          prompt,
          aspect_ratio: aspectRatio,
          output: outputPath,
          images_generated: predictions.length,
        },
        artifacts: [outputPath],
        cost_usd: this.estimateCost(inputs),
        duration_seconds: Math.round((Date.now() - start) / 10) / 100,
        model,
      });
    } catch (e) {
      return toolResult({ success: false, error: `Imagen generation failed: ${(e as Error).message}` });
    }
  }
}
