/**
 * OpenAI GPT Image generation (gpt-image-1 / DALL-E 3).
 *
 * TypeScript port of tools/graphics/openai_image.py. The Python tool called the
 * `openai` SDK (`client.images.generate(...)`); this port is a real `fetch`
 * translation of the single HTTP call that SDK makes under the hood
 * (POST {base}/images/generations), then decodes the returned b64_json.
 *
 * Parity notes vs. Python:
 *  - Python declared dependencies=[] and overrode get_status() to check
 *    OPENAI_API_KEY directly. The TS port declares
 *    dependencies=["env:OPENAI_API_KEY"] so the base getStatus() drives
 *    preflight availability — behaviorally identical (UNAVAILABLE without the
 *    key) and keeps openai in setup_offers.
 *  - `client = OpenAI()` reads OPENAI_API_KEY (and honors OPENAI_BASE_URL /
 *    OPENAI_ORG_ID / OPENAI_PROJECT_ID); the fetch translation mirrors that.
 *  - The two model branches (gpt-image-1 vs. dall-e-3), the dall-e-3 quality
 *    remap, the n=1 clamp for dall-e-3, default size/quality/output_format, the
 *    b64 decode of data[0], the output extension, and the cost estimate all
 *    match the Python verbatim.
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

export class OpenAIImage extends BaseTool {
  override name = "openai_image";
  override version = "0.1.0";
  override tier = ToolTier.GENERATE;
  override capability = "image_generation";
  override provider = "openai";
  override stability = ToolStability.BETA;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.STOCHASTIC;
  override runtime = ToolRuntime.API;

  override dependencies = ["env:OPENAI_API_KEY"];
  override install_instructions =
    "Set OPENAI_API_KEY to your OpenAI API key.\n" + "  pip install openai";
  override agent_skills = ["flux-best-practices"]; // general image gen knowledge

  override capabilities = ["generate_image", "generate_illustration", "text_to_image"];
  override supports = {
    complex_instructions: true,
    text_in_image: true,
    multiple_outputs: true,
  };
  override best_for = [
    "complex multi-element compositions",
    "images with text/labels",
    "following detailed instructions accurately",
  ];
  override not_good_for = [
    "offline generation",
    "budget-constrained projects at high quality",
  ];

  override input_schema = {
    type: "object",
    required: ["prompt"],
    properties: {
      prompt: { type: "string" },
      model: {
        type: "string",
        enum: ["gpt-image-1", "dall-e-3"],
        default: "gpt-image-1",
      },
      size: {
        type: "string",
        enum: [
          "1024x1024",
          "1536x1024",
          "1024x1536",
          "auto",
          "1024x1792",
          "1792x1024", // dall-e-3 only
        ],
        default: "1024x1024",
      },
      quality: {
        type: "string",
        enum: ["low", "medium", "high", "auto", "standard", "hd"],
        default: "high",
      },
      output_format: {
        type: "string",
        enum: ["png", "jpeg", "webp"],
        default: "png",
      },
      n: { type: "integer", default: 1, minimum: 1, maximum: 4 },
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
  override idempotency_key_fields = ["prompt", "size", "quality", "model"];
  override side_effects = ["writes image file to output_path", "calls OpenAI API"];
  override user_visible_verification = [
    "Inspect generated image for relevance and quality",
  ];

  override estimateCost(inputs: Record<string, unknown>): number {
    const model = (inputs.model as string) ?? "gpt-image-1";
    const quality = (inputs.quality as string) ?? "high";
    const n = (inputs.n as number) ?? 1;
    if (model === "gpt-image-1") {
      const costMap: Record<string, number> = {
        low: 0.011,
        medium: 0.042,
        high: 0.167,
        auto: 0.042,
      };
      return (costMap[quality] ?? 0.042) * n;
    }
    // dall-e-3 fallback pricing
    const qualityMap: Record<string, number> = { standard: 0.04, hd: 0.08 };
    return (qualityMap[quality] ?? 0.04) * n;
  }

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return toolResult({
        success: false,
        error: "OPENAI_API_KEY not set. " + this.install_instructions,
      });
    }

    const start = Date.now();
    const model = (inputs.model as string) ?? "gpt-image-1";
    const prompt = inputs.prompt as string;
    const size = (inputs.size as string) ?? "1024x1024";
    const n = (inputs.n as number) ?? 1;

    let outputPath: string;
    try {
      // Build the request body exactly as the openai SDK's images.generate would.
      const body: Record<string, unknown> = { model, prompt, size };
      if (model === "gpt-image-1") {
        body.quality = (inputs.quality as string) ?? "high";
        body.output_format = (inputs.output_format as string) ?? "png";
        body.n = n;
      } else {
        // dall-e-3 path
        let quality = (inputs.quality as string) ?? "standard";
        if (["low", "medium", "high", "auto"].includes(quality)) {
          quality = "standard"; // map to dall-e-3 quality options
        }
        body.quality = quality;
        body.n = 1; // dall-e-3 only supports n=1
        body.response_format = "b64_json";
      }

      // OpenAI() honors OPENAI_BASE_URL (default https://api.openai.com/v1) and
      // optional org/project headers.
      const baseUrl = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(
        /\/+$/,
        ""
      );
      const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      };
      if (process.env.OPENAI_ORG_ID)
        headers["OpenAI-Organization"] = process.env.OPENAI_ORG_ID;
      if (process.env.OPENAI_PROJECT_ID)
        headers["OpenAI-Project"] = process.env.OPENAI_PROJECT_ID;

      const response = await fetch(`${baseUrl}/images/generations`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const errBody = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status} ${response.statusText}: ${errBody}`);
      }
      const data = (await response.json()) as {
        data: Array<{ b64_json?: string }>;
      };

      const imageData = Buffer.from(data.data[0]!.b64_json as string, "base64");
      const ext = (inputs.output_format as string) ?? "png";
      outputPath = (inputs.output_path as string) ?? `generated_image.${ext}`;
      fs.mkdirSync(path.dirname(outputPath) || ".", { recursive: true });
      fs.writeFileSync(outputPath, imageData);
    } catch (e) {
      return toolResult({
        success: false,
        error: `OpenAI image generation failed: ${(e as Error).message ?? e}`,
      });
    }

    return toolResult({
      success: true,
      data: {
        provider: "openai",
        model,
        prompt,
        output: outputPath,
      },
      artifacts: [outputPath],
      cost_usd: this.estimateCost(inputs),
      duration_seconds: Math.round((Date.now() - start) / 10) / 100,
      model,
    });
  }
}
