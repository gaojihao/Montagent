/**
 * FLUX image generation via fal.ai API.
 *
 * TypeScript port of tools/graphics/flux_image.py. Faithful contract
 * (capability="image_generation", provider="flux", runtime API) so preflight
 * groups it correctly, plus a real fetch translation of the Python requests
 * flow (POST to fal.run, download the returned image URL, write to disk).
 *
 * Parity notes vs. Python:
 *  - Python declared dependencies=[] and overrode get_status() to accept either
 *    FAL_KEY or FAL_AI_API_KEY. The TS port declares dependencies=["env:FAL_KEY"]
 *    so the base getStatus() drives preflight availability (and keeps flux in
 *    setup_offers), while execute() still accepts either env var via getApiKey().
 *  - Endpoint, headers, payload (image_size, optional seed/steps/guidance/
 *    negative_prompt), and cost estimate match the Python verbatim.
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

export class FluxImage extends BaseTool {
  override name = "flux_image";
  override version = "0.1.0";
  override tier = ToolTier.GENERATE;
  override capability = "image_generation";
  override provider = "flux";
  override stability = ToolStability.BETA;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.SEEDED;
  override runtime = ToolRuntime.API;

  override dependencies = ["env:FAL_KEY"];
  override install_instructions =
    "Set FAL_KEY to your fal.ai API key.\n" +
    "  Get one at https://fal.ai/dashboard/keys";
  override agent_skills = ["flux-best-practices", "bfl-api"];

  override capabilities = [
    "generate_image",
    "generate_illustration",
    "text_to_image",
  ];
  override supports = {
    negative_prompt: true,
    seed: true,
    custom_size: true,
  };
  override best_for = [
    "photorealistic images",
    "general-purpose image generation",
    "high quality at low cost (~$0.03/image)",
  ];
  override not_good_for = ["text rendering in images", "offline generation"];

  override input_schema = {
    type: "object",
    required: ["prompt"],
    properties: {
      prompt: { type: "string" },
      negative_prompt: { type: "string", default: "" },
      width: { type: "integer", default: 1024 },
      height: { type: "integer", default: 1024 },
      model: {
        type: "string",
        enum: ["flux-pro/v1.1", "flux/dev", "flux-pro"],
        default: "flux-pro/v1.1",
      },
      seed: { type: "integer" },
      num_inference_steps: { type: "integer" },
      guidance_scale: { type: "number" },
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
    "width",
    "height",
    "seed",
    "model",
  ];
  override side_effects = [
    "writes image file to output_path",
    "calls fal.ai API",
  ];
  override user_visible_verification = [
    "Inspect generated image for relevance and quality",
  ];

  private getApiKey(): string | undefined {
    return process.env.FAL_KEY ?? process.env.FAL_AI_API_KEY;
  }

  override estimateCost(inputs: Record<string, unknown>): number {
    const model = (inputs.model as string) ?? "flux-pro/v1.1";
    return model.includes("pro") ? 0.05 : 0.03; // dev tier = 0.03
  }

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      return toolResult({
        success: false,
        error: "No fal.ai API key found. " + this.install_instructions,
      });
    }

    const start = Date.now();
    const model = (inputs.model as string) ?? "flux-pro/v1.1";
    const prompt = inputs.prompt as string;
    const width = (inputs.width as number) ?? 1024;
    const height = (inputs.height as number) ?? 1024;

    const payload: Record<string, unknown> = {
      prompt,
      image_size: { width, height },
    };
    if (inputs.seed !== undefined && inputs.seed !== null)
      payload.seed = inputs.seed;
    if (inputs.num_inference_steps)
      payload.num_inference_steps = inputs.num_inference_steps;
    if (inputs.guidance_scale) payload.guidance_scale = inputs.guidance_scale;
    if (inputs.negative_prompt)
      payload.negative_prompt = inputs.negative_prompt;

    let outputPath: string;
    let seed: unknown;
    try {
      const response = await fetch(`https://fal.run/fal-ai/${model}`, {
        method: "POST",
        headers: {
          Authorization: `Key ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `HTTP ${response.status} ${response.statusText}: ${body}`
        );
      }
      const data = (await response.json()) as {
        images: Array<{ url: string }>;
        seed?: unknown;
      };

      const imageUrl = data.images[0]!.url;
      const imageResponse = await fetch(imageUrl);
      if (!imageResponse.ok) {
        throw new Error(
          `HTTP ${imageResponse.status} downloading image: ${imageUrl}`
        );
      }

      outputPath = path.resolve(
        (inputs.output_path as string) ?? "generated_image.png"
      );
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      const buf = Buffer.from(await imageResponse.arrayBuffer());
      fs.writeFileSync(outputPath, buf);
      seed = data.seed;
    } catch (e) {
      return toolResult({
        success: false,
        error: `FLUX generation failed: ${(e as Error).message ?? e}`,
      });
    }

    return toolResult({
      success: true,
      data: {
        provider: "flux",
        model,
        prompt,
        output: outputPath,
        seed: seed ?? null,
      },
      artifacts: [outputPath],
      cost_usd: this.estimateCost(inputs),
      duration_seconds: Math.round((Date.now() - start) / 10) / 100,
      seed: (seed as number) ?? null,
      model: `fal-ai/${model}`,
    });
  }
}
