/**
 * Image generation router for diagrams, overlays, and illustrations (TS port of
 * tools/graphics/image_gen.py).
 *
 * @deprecated Use image_selector instead. Kept for backwards compatibility.
 *
 * Parity note: the Python version supported OpenAI (DALL-E), FLUX (fal.ai), AND a
 * local Stable Diffusion (diffusers/torch) branch. Per the "no GPU/PyTorch" exemption,
 * the local branch is DROPPED: provider detection no longer probes diffusers, and the
 * "local" generation path is removed. OpenAI + FLUX (cloud) are ported via fetch.
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

export class ImageGen extends BaseTool {
  override name = "image_gen";
  override version = "0.1.0";
  override tier = ToolTier.CORE;
  override capability = "image_generation";
  override provider = "multi";
  override stability = ToolStability.EXPERIMENTAL;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.SEEDED;
  override runtime = ToolRuntime.HYBRID; // API (DALL-E/FLUX); local diffusers branch dropped in TS port

  override dependencies: string[] = []; // checked dynamically based on provider
  override install_instructions =
    "Set one of these environment variables:\n" +
    "  OPENAI_API_KEY — for DALL-E 3\n" +
    "  FAL_KEY — for FLUX via fal.ai\n" +
    "(Local diffusers generation is unavailable in the TypeScript port — use a cloud provider.)";
  override agent_skills = ["flux-best-practices", "bfl-api"];

  override capabilities = ["generate_image", "generate_diagram_overlay", "generate_illustration"];
  override best_for = [
    "DEPRECATED — prefer image_selector which routes to per-provider tools " +
      "(flux_image, openai_image, recraft_image, grok_image, local_diffusion, " +
      "pexels_image, pixabay_image).",
    "Kept only for backwards compatibility. New code should not call this.",
  ];
  override not_good_for = [
    "New production code — use image_selector instead.",
    "Picking a specific provider (use the per-provider tool directly).",
  ];

  override input_schema = {
    type: "object",
    required: ["prompt"],
    properties: {
      prompt: { type: "string" },
      negative_prompt: { type: "string", default: "" },
      width: { type: "integer", default: 1024 },
      height: { type: "integer", default: 1024 },
      provider: { type: "string", enum: ["openai", "flux", "local"], description: "Auto-detected if not specified" },
      model: { type: "string" },
      seed: { type: "integer" },
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
  override idempotency_key_fields = ["prompt", "width", "height", "seed"];
  override side_effects = ["writes image file to output_path", "calls external API"];
  override user_visible_verification = ["Inspect generated image for relevance and quality"];

  override getStatus(): ToolStatus {
    return this.detectProvider() ? ToolStatus.AVAILABLE : ToolStatus.UNAVAILABLE;
  }

  /** Detect an available cloud provider. The local diffusers branch is dropped. */
  private detectProvider(): string | null {
    if (process.env.OPENAI_API_KEY) return "openai";
    if (process.env.FAL_KEY || process.env.FAL_AI_API_KEY) return "flux";
    return null;
  }

  override estimateCost(inputs: Record<string, unknown>): number {
    const provider = (inputs.provider as string) || this.detectProvider();
    if (provider === "openai") return 0.04; // DALL-E 3 standard
    if (provider === "flux") return 0.03;
    return 0.0;
  }

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const provider = (inputs.provider as string) || this.detectProvider();
    if (!provider) {
      return toolResult({ success: false, error: "No image generation provider available. " + this.install_instructions });
    }

    const start = Date.now();
    let result: ToolResult;
    try {
      if (provider === "openai") result = await this.generateOpenAI(inputs);
      else if (provider === "flux") result = await this.generateFlux(inputs);
      else if (provider === "local")
        return toolResult({
          success: false,
          error: "Local diffusers generation is unavailable in the TypeScript port. Use OPENAI_API_KEY or FAL_KEY.",
        });
      else return toolResult({ success: false, error: `Unknown provider: ${provider}` });
    } catch (e) {
      return toolResult({ success: false, error: `Generation failed: ${(e as Error).message}` });
    }

    result.duration_seconds = Math.round((Date.now() - start) / 10) / 100;
    result.cost_usd = this.estimateCost(inputs);
    return result;
  }

  /** DALL-E via the OpenAI images endpoint (requests/SDK -> fetch). */
  private async generateOpenAI(inputs: Record<string, unknown>): Promise<ToolResult> {
    const apiKey = process.env.OPENAI_API_KEY as string;
    const prompt = inputs.prompt as string;
    const size = `${(inputs.width as number) ?? 1024}x${(inputs.height as number) ?? 1024}`;
    const model = (inputs.model as string) ?? "dall-e-3";

    const response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, size, n: 1, response_format: "b64_json" }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${body}`);
    }
    const data = (await response.json()) as { data: Array<{ b64_json: string }> };
    const imageData = Buffer.from(data.data[0]!.b64_json, "base64");
    const outputPath = path.resolve((inputs.output_path as string) ?? "generated_image.png");
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, imageData);

    return toolResult({
      success: true,
      data: { provider: "openai", model, prompt, output: outputPath },
      artifacts: [outputPath],
      model,
    });
  }

  /** FLUX dev via fal.ai (requests -> fetch). */
  private async generateFlux(inputs: Record<string, unknown>): Promise<ToolResult> {
    const apiKey = process.env.FAL_KEY || process.env.FAL_AI_API_KEY;
    const prompt = inputs.prompt as string;
    const width = (inputs.width as number) ?? 1024;
    const height = (inputs.height as number) ?? 1024;
    const seed = inputs.seed as number | undefined;

    const payload: Record<string, unknown> = { prompt, image_size: { width, height } };
    if (seed != null) payload.seed = seed;

    const response = await fetch("https://fal.run/fal-ai/flux/dev", {
      method: "POST",
      headers: { Authorization: `Key ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${body}`);
    }
    const data = (await response.json()) as { images: Array<{ url: string }>; seed?: number };
    const imageResponse = await fetch(data.images[0]!.url);
    if (!imageResponse.ok) throw new Error(`download HTTP ${imageResponse.status}`);
    const outputPath = path.resolve((inputs.output_path as string) ?? "generated_image.png");
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, Buffer.from(await imageResponse.arrayBuffer()));

    return toolResult({
      success: true,
      data: { provider: "flux", prompt, output: outputPath, seed: data.seed ?? null },
      artifacts: [outputPath],
      seed: data.seed ?? null,
      model: "flux-dev",
    });
  }
}
