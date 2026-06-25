/**
 * Recraft V4 image generation via fal.ai API.
 *
 * Best for logos, brand assets, SVG vectors, and images with accurate text
 * rendering.
 *
 * TypeScript port of tools/graphics/recraft_image.py. Faithful contract
 * (capability="image_generation", provider="recraft", runtime API) plus a real
 * fetch translation of the Python requests flow: POST to the model's
 * text-to-image route on fal.run, download the returned image URL, and write
 * it to disk.
 *
 * Parity notes vs. Python:
 *  - Python declared dependencies=[] and overrode get_status() to accept either
 *    FAL_KEY or FAL_AI_API_KEY. The TS port declares
 *    dependencies=["env:FAL_KEY"] so the base getStatus() drives preflight
 *    availability (and keeps recraft in setup_offers), while execute() still
 *    accepts either env var via getApiKey().
 *  - The model_path mapping (v4 -> recraft/v4/text-to-image, v4-pro ->
 *    recraft/v4/pro/text-to-image), the style/colors/image_size pass-through
 *    (including the known fal.ai `style` 422 caveat preserved as a comment),
 *    the svg-vs-png extension rule, and the cost estimate all match the Python
 *    verbatim.
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

export class RecraftImage extends BaseTool {
  override name = "recraft_image";
  override version = "0.1.0";
  override tier = ToolTier.GENERATE;
  override capability = "image_generation";
  override provider = "recraft";
  override stability = ToolStability.EXPERIMENTAL;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.STOCHASTIC;
  override runtime = ToolRuntime.API;

  override dependencies = ["env:FAL_KEY"];
  override install_instructions =
    "Set FAL_KEY to your fal.ai API key.\n" + "  Get one at https://fal.ai/dashboard/keys";
  override agent_skills = [];

  override capabilities = [
    "generate_image",
    "generate_logo",
    "generate_vector",
    "text_to_image",
  ];
  override supports = {
    svg_output: true,
    text_rendering: true,
    color_palette: true,
    custom_size: true,
  };
  override best_for = [
    "logos and brand assets",
    "SVG vector output",
    "images with accurate text rendering",
    "clean professional graphics",
  ];
  override not_good_for = ["photorealistic images", "offline generation"];

  override input_schema = {
    type: "object",
    required: ["prompt"],
    properties: {
      prompt: { type: "string" },
      model: {
        type: "string",
        enum: ["v4", "v4-pro"],
        default: "v4",
      },
      image_size: {
        type: "string",
        enum: [
          "square",
          "square_hd",
          "landscape_4_3",
          "landscape_16_9",
          "portrait_4_3",
          "portrait_16_9",
        ],
        default: "square_hd",
      },
      style: {
        type: "string",
        enum: [
          "any",
          "realistic_image",
          "digital_illustration",
          "vector_illustration",
          "icon",
        ],
        default: "any",
      },
      colors: {
        type: "array",
        items: { type: "string" },
        description: "Color palette as hex strings, e.g. ['#FF5733', '#2E86C1']",
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
  override idempotency_key_fields = ["prompt", "model", "style", "image_size"];
  override side_effects = ["writes image file to output_path", "calls fal.ai API"];
  override user_visible_verification = [
    "Inspect generated image for brand accuracy and text readability",
  ];

  private getApiKey(): string | undefined {
    return process.env.FAL_KEY ?? process.env.FAL_AI_API_KEY;
  }

  override estimateCost(inputs: Record<string, unknown>): number {
    const model = (inputs.model as string) ?? "v4";
    if (model === "v4-pro") {
      return 0.25;
    }
    return 0.04;
  }

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      return toolResult({
        success: false,
        error: "FAL_KEY not set. " + this.install_instructions,
      });
    }

    const start = Date.now();
    const model = (inputs.model as string) ?? "v4";
    const prompt = inputs.prompt as string;

    let modelPath = `recraft/${model}/text-to-image`;
    if (model === "v4-pro") {
      modelPath = "recraft/v4/pro/text-to-image";
    } else if (model === "v4") {
      modelPath = "recraft/v4/text-to-image";
    }

    const payload: Record<string, unknown> = { prompt };
    if (inputs.image_size) payload.image_size = inputs.image_size;
    if (inputs.style) {
      // NOTE: As of 2026-04, fal.ai's Recraft V4 endpoint rejects the
      // `style` parameter with a 422 Unprocessable Entity error. The
      // style enum values (digital_illustration, realistic_image, etc.)
      // are NOT accepted by the /fal-ai/recraft/v4/text-to-image route.
      // Workaround: encode the style direction in the prompt text instead
      // (e.g. "digital illustration of..." rather than style="digital_illustration").
      // We still pass the parameter through in case fal.ai re-enables it,
      // but callers should be aware this may fail.
      payload.style = inputs.style;
    }
    if (inputs.colors) payload.colors = inputs.colors;

    let outputPath: string;
    try {
      const response = await fetch(`https://fal.run/fal-ai/${modelPath}`, {
        method: "POST",
        headers: {
          Authorization: `Key ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status} ${response.statusText}: ${body}`);
      }
      const data = (await response.json()) as { images: Array<{ url: string }> };

      const imageUrl = data.images[0]!.url;
      const imageResponse = await fetch(imageUrl);
      if (!imageResponse.ok) {
        throw new Error(
          `HTTP ${imageResponse.status} ${imageResponse.statusText} downloading ${imageUrl}`
        );
      }

      const ext = inputs.style === "vector_illustration" ? "svg" : "png";
      outputPath = (inputs.output_path as string) ?? `generated_image.${ext}`;
      fs.mkdirSync(path.dirname(outputPath) || ".", { recursive: true });
      fs.writeFileSync(outputPath, Buffer.from(await imageResponse.arrayBuffer()));
    } catch (e) {
      return toolResult({
        success: false,
        error: `Recraft generation failed: ${(e as Error).message ?? e}`,
      });
    }

    return toolResult({
      success: true,
      data: {
        provider: "recraft",
        model,
        prompt,
        output: outputPath,
      },
      artifacts: [outputPath],
      cost_usd: this.estimateCost(inputs),
      duration_seconds: Math.round((Date.now() - start) / 10) / 100,
      model: `fal-ai/${modelPath}`,
    });
  }
}
