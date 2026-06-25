/**
 * Seedance 2.0 (ByteDance) video generation via Replicate.
 *
 * Replicate hosts ByteDance's published Seedance 2.0 models:
 *   - bytedance/seedance-2.0        (standard)
 *   - bytedance/seedance-2.0-fast   (fast tier)
 *
 * Same model family as the fal.ai path (tools/video/seedance_video.ts) —
 * if you have both FAL_KEY and REPLICATE_API_TOKEN the scoring engine
 * deduplicates by provider=seedance and picks whichever registers first.
 *
 * TypeScript port of tools/video/seedance_replicate.py. execute() is a real
 * fetch-based translation of the Python requests flow: POST a prediction with
 * Prefer: wait=60, poll urls.get every 3s while starting/processing, then
 * download the output (string URL or first list element).
 *
 * Parity notes vs. Python:
 *  - Python declared dependencies=[] and overrode get_status() to check
 *    REPLICATE_API_TOKEN directly. The TS port declares
 *    dependencies=["env:REPLICATE_API_TOKEN"] so the base getStatus() drives
 *    availability — behaviorally identical.
 *  - Model slug selection, payload assembly, headers, poll loop, cost/runtime
 *    estimates, and result fields all match the Python verbatim.
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
import { probeOutput } from "./_shared.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class SeedanceReplicate extends BaseTool {
  override name = "seedance_replicate";
  override version = "0.1.0";
  override tier = ToolTier.GENERATE;
  override capability = "video_generation";
  override provider = "seedance";
  override stability = ToolStability.BETA;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.STOCHASTIC;
  override runtime = ToolRuntime.API;

  override dependencies = ["env:REPLICATE_API_TOKEN"];
  override install_instructions =
    "Set REPLICATE_API_TOKEN to your Replicate API token.\n" +
    "  Get one at https://replicate.com/account/api-tokens";
  override agent_skills = ["seedance-2-0", "ai-video-gen"];

  override capabilities = ["text_to_video", "image_to_video"];
  override supports = {
    text_to_video: true,
    image_to_video: true,
    reference_image: true,
    native_audio: true,
    cinematic_quality: true,
    camera_direction: true,
    lip_sync: true,
    multi_shot: true,
    aspect_ratio: true,
    seed: true,
  };
  override best_for = [
    "preferred premium video gen when REPLICATE_API_TOKEN is available",
    "cinematic trailers, teasers, and high-fidelity clips with native synchronized audio",
    "director-level camera control and multi-shot editing in a single generation",
    "lip-sync from quoted dialogue in prompts",
    "consistent character identity across shots",
  ];
  override not_good_for = ["offline generation", "budget-constrained projects"];
  override fallback_tools = ["seedance_video", "veo_video", "kling_video", "minimax_video"];
  override quality_score = 0.95;

  override input_schema = {
    type: "object",
    required: ["prompt"],
    properties: {
      prompt: { type: "string" },
      operation: {
        type: "string",
        enum: ["text_to_video", "image_to_video"],
        default: "text_to_video",
      },
      model_variant: {
        type: "string",
        enum: ["standard", "fast"],
        default: "standard",
        description: "standard = bytedance/seedance-2.0, fast = bytedance/seedance-2.0-fast",
      },
      duration: {
        type: "string",
        enum: ["auto", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"],
        default: "5",
      },
      aspect_ratio: {
        type: "string",
        enum: ["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
        default: "16:9",
      },
      resolution: {
        type: "string",
        enum: ["480p", "720p"],
        default: "720p",
      },
      generate_audio: {
        type: "boolean",
        default: true,
      },
      image_url: {
        type: "string",
        description: "Start frame image URL for image_to_video",
      },
      seed: { type: "integer" },
      output_path: { type: "string" },
    },
  };

  override resource_profile: ResourceProfile = {
    cpu_cores: 1,
    ram_mb: 512,
    vram_mb: 0,
    disk_mb: 500,
    network_required: true,
  };
  override retry_policy: RetryPolicy = {
    max_retries: 2,
    backoff_seconds: 1.0,
    retryable_errors: ["rate_limit", "timeout"],
  };
  override idempotency_key_fields = ["prompt", "model_variant", "operation", "duration", "seed"];
  override side_effects = [
    "writes video file to output_path",
    "calls Replicate API",
  ];
  override user_visible_verification = [
    "Watch generated clip for motion coherence, audio sync, and visual quality",
  ];

  private getApiToken(): string | undefined {
    return process.env.REPLICATE_API_TOKEN;
  }

  override estimateCost(inputs: Record<string, unknown>): number {
    const variant = (inputs.model_variant as string) ?? "standard";
    const duration = (inputs.duration as string) ?? "5";
    const secs = duration === "auto" ? 5 : parseInt(duration, 10);
    // Replicate bills per-second at roughly the same rate as fal.ai for this model family.
    const rate = variant === "fast" ? 0.24 : 0.3;
    return Math.round(rate * secs * 100) / 100;
  }

  override estimateRuntime(inputs: Record<string, unknown>): number {
    return inputs.model_variant === "fast" ? 60.0 : 120.0;
  }

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const token = this.getApiToken();
    if (!token) {
      return toolResult({
        success: false,
        error: "REPLICATE_API_TOKEN not set. " + this.install_instructions,
      });
    }

    const start = Date.now();
    const variant = (inputs.model_variant as string) ?? "standard";
    const modelSlug =
      variant === "fast" ? "bytedance/seedance-2.0-fast" : "bytedance/seedance-2.0";

    const payloadInput: Record<string, unknown> = { prompt: inputs.prompt };
    if (inputs.duration && inputs.duration !== "auto") {
      payloadInput.duration = parseInt(inputs.duration as string, 10);
    }
    if (inputs.aspect_ratio && inputs.aspect_ratio !== "auto") {
      payloadInput.aspect_ratio = inputs.aspect_ratio;
    }
    if (inputs.resolution) payloadInput.resolution = inputs.resolution;
    if ("generate_audio" in inputs) payloadInput.generate_audio = inputs.generate_audio;
    if (inputs.seed != null) payloadInput.seed = inputs.seed;
    if (inputs.operation === "image_to_video" && inputs.image_url) {
      payloadInput.image = inputs.image_url;
    }

    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "wait=60",
    };

    let pred: Record<string, any>;
    let outputPath: string;

    try {
      const submit = await fetch(
        `https://api.replicate.com/v1/models/${modelSlug}/predictions`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ input: payloadInput }),
          signal: AbortSignal.timeout(90000),
        }
      );
      if (!submit.ok) {
        const body = await submit.text().catch(() => "");
        throw new Error(`HTTP ${submit.status} ${submit.statusText}: ${body}`);
      }
      pred = (await submit.json()) as Record<string, any>;

      // Poll until completed (Replicate may return the result synchronously
      // when Prefer: wait is honored, but fall back to polling).
      while (pred.status === "starting" || pred.status === "processing") {
        await sleep(3000);
        const getUrl = pred.urls?.get as string | undefined;
        if (!getUrl) {
          return toolResult({ success: false, error: "Replicate response missing poll URL" });
        }
        const poll = await fetch(getUrl, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(30000),
        });
        if (!poll.ok) {
          const body = await poll.text().catch(() => "");
          throw new Error(`HTTP ${poll.status} ${poll.statusText}: ${body}`);
        }
        pred = (await poll.json()) as Record<string, any>;
      }

      const status = pred.status;
      if (status !== "succeeded") {
        return toolResult({
          success: false,
          error: `Replicate Seedance 2.0 generation ${status}: ${pred.error}`,
        });
      }

      const output = pred.output;
      // Replicate returns either a string URL or a list.
      const videoUrl = Array.isArray(output) ? output[0] : output;
      if (typeof videoUrl !== "string") {
        return toolResult({
          success: false,
          error: `Unexpected output shape from Replicate: ${pyRepr(output)}`,
        });
      }

      const videoResponse = await fetch(videoUrl, { signal: AbortSignal.timeout(180000) });
      if (!videoResponse.ok) {
        const body = await videoResponse.text().catch(() => "");
        throw new Error(`HTTP ${videoResponse.status} ${videoResponse.statusText}: ${body}`);
      }

      outputPath = (inputs.output_path as string) ?? "seedance_replicate_output.mp4";
      fs.mkdirSync(path.dirname(path.resolve(outputPath)) || ".", { recursive: true });
      fs.writeFileSync(outputPath, Buffer.from(await videoResponse.arrayBuffer()));
    } catch (e) {
      return toolResult({
        success: false,
        error: `Replicate Seedance 2.0 generation failed: ${(e as Error).message ?? e}`,
      });
    }

    const probed = await probeOutput(outputPath);
    return toolResult({
      success: true,
      data: {
        provider: "seedance",
        gateway: "replicate",
        model: modelSlug,
        prompt: inputs.prompt,
        variant,
        aspect_ratio: (inputs.aspect_ratio as string) ?? "16:9",
        resolution: (inputs.resolution as string) ?? "720p",
        generate_audio: (inputs.generate_audio as boolean) ?? true,
        seed: pred.input?.seed ?? null,
        output: outputPath,
        output_path: outputPath,
        format: "mp4",
        ...probed,
      },
      artifacts: [outputPath],
      cost_usd: this.estimateCost(inputs),
      duration_seconds: Math.round((Date.now() - start) / 10) / 100,
      model: modelSlug,
    });
  }
}

/** Mirror Python's repr() of an arbitrary value for the error message. */
function pyRepr(value: unknown): string {
  if (typeof value === "string") return `'${value}'`;
  if (value === null || value === undefined) return "None";
  return JSON.stringify(value);
}
