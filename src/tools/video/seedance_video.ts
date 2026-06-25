/**
 * Seedance 2.0 (ByteDance) video generation via fal.ai API.
 *
 * Best for cinematic clips with native audio, director-level camera control,
 * and lip-sync from quoted dialogue in prompts.
 *
 * TypeScript port of tools/video/seedance_video.py. execute() is a real
 * fetch-based translation of the Python requests flow: submit to the fal.ai
 * queue, poll status_url every 5s until COMPLETED, fetch response_url, then
 * download the returned video. Local image/reference paths are auto-uploaded to
 * fal.ai storage via the shared uploadImageFal helper.
 *
 * Parity notes vs. Python:
 *  - Python declared dependencies=[] and overrode get_status() to accept either
 *    FAL_KEY or FAL_AI_API_KEY. The TS port declares
 *    dependencies=["env:FAL_KEY"] so the base getStatus() drives preflight
 *    availability, while execute() still accepts either env var via getApiKey().
 *  - Model-path construction, payload assembly, reference-image/video/audio
 *    ceilings (9 / 3 / 3), poll loop, cost/runtime estimates, and result fields
 *    (seed read from the result response, not the input) all match Python verbatim.
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
import { probeOutput, uploadImageFal } from "./_shared.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class SeedanceVideo extends BaseTool {
  override name = "seedance_video";
  override version = "0.2.0";
  override tier = ToolTier.GENERATE;
  override capability = "video_generation";
  override provider = "seedance";
  override stability = ToolStability.BETA;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.STOCHASTIC;
  override runtime = ToolRuntime.API;

  override dependencies = ["env:FAL_KEY"];
  override install_instructions =
    "Set FAL_KEY to your fal.ai API key.\n" +
    "  Get one at https://fal.ai/dashboard/keys";
  override agent_skills = ["seedance-2-0", "ai-video-gen"];

  override capabilities = ["text_to_video", "image_to_video", "reference_to_video"];
  override supports = {
    text_to_video: true,
    image_to_video: true,
    reference_to_video: true,
    multiple_reference_images: true,
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
    "preferred premium video gen when FAL_KEY is available",
    "cinematic trailers, teasers, and high-fidelity clips with native synchronized audio",
    "director-level camera control and multi-shot editing in a single generation",
    "lip-sync from quoted dialogue in prompts",
    "reference-conditioned generation (up to 9 images + 3 video clips + 3 audio clips)",
    "consistent character identity across shots",
  ];
  override not_good_for = ["offline generation", "budget-constrained projects"];
  // Premium model — beat out "experimental stability" baseline. The scoring
  // engine reads quality_score directly when present (see lib/scoring.py).
  override quality_score = 0.95;

  override input_schema = {
    type: "object",
    required: ["prompt"],
    properties: {
      prompt: { type: "string" },
      operation: {
        type: "string",
        enum: ["text_to_video", "image_to_video", "reference_to_video"],
        default: "text_to_video",
      },
      model_variant: {
        type: "string",
        enum: ["standard", "fast"],
        default: "standard",
        description: "standard = highest quality, fast = lower latency and cost",
      },
      duration: {
        type: "string",
        enum: ["auto", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"],
        default: "5",
        description: "Duration in seconds. 'auto' lets the model decide.",
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
        description: "Generate synchronized audio (speech, SFX, ambient)",
      },
      image_url: {
        type: "string",
        description: "Start frame image URL for image_to_video (jpg, png, webp)",
      },
      image_path: {
        type: "string",
        description: "Local start-frame path for image_to_video. Auto-uploaded to fal.ai storage.",
      },
      end_image_url: {
        type: "string",
        description: "Optional end frame URL for image_to_video",
      },
      reference_image_urls: {
        type: "array",
        items: { type: "string" },
        description:
          "Up to 9 reference image URLs for reference_to_video (identity / wardrobe / setting / style anchors).",
      },
      reference_image_paths: {
        type: "array",
        items: { type: "string" },
        description:
          "Local reference image paths for reference_to_video. Auto-uploaded to fal.ai storage.",
      },
      reference_video_urls: {
        type: "array",
        items: { type: "string" },
        description:
          "Up to 3 reference video clip URLs for reference_to_video (motion / camera / pacing anchors).",
      },
      reference_audio_urls: {
        type: "array",
        items: { type: "string" },
        description:
          "Up to 3 reference audio clip URLs for reference_to_video (voice / music / ambience anchors).",
      },
      seed: {
        type: "integer",
        description: "Optional seed for reproducibility",
      },
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
    "calls fal.ai API",
  ];
  override user_visible_verification = [
    "Watch generated clip for motion coherence, audio sync, and visual quality",
  ];

  private getApiKey(): string | undefined {
    return process.env.FAL_KEY ?? process.env.FAL_AI_API_KEY;
  }

  override estimateCost(inputs: Record<string, unknown>): number {
    const variant = (inputs.model_variant as string) ?? "standard";
    const duration = (inputs.duration as string) ?? "5";
    const secs = duration === "auto" ? 5 : parseInt(duration, 10);
    const rate = variant === "fast" ? 0.2419 : 0.3034;
    return Math.round(rate * secs * 100) / 100;
  }

  override estimateRuntime(inputs: Record<string, unknown>): number {
    const variant = (inputs.model_variant as string) ?? "standard";
    return variant === "fast" ? 60.0 : 120.0;
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
    const operation = (inputs.operation as string) ?? "text_to_video";
    const variant = (inputs.model_variant as string) ?? "standard";
    const operationPath = operation.replace(/_/g, "-");

    const modelPath =
      variant === "fast"
        ? `bytedance/seedance-2.0/fast/${operationPath}`
        : `bytedance/seedance-2.0/${operationPath}`;

    const payload: Record<string, unknown> = { prompt: inputs.prompt };

    if (inputs.duration) payload.duration = inputs.duration;
    if (inputs.aspect_ratio) payload.aspect_ratio = inputs.aspect_ratio;
    if (inputs.resolution) payload.resolution = inputs.resolution;
    if ("generate_audio" in inputs) payload.generate_audio = inputs.generate_audio;
    if (inputs.seed != null) payload.seed = inputs.seed;

    let data: Record<string, any>;
    let outputPath: string;

    try {
      if (operation === "image_to_video") {
        if (inputs.image_url) {
          payload.image_url = inputs.image_url;
        } else if (inputs.image_path) {
          payload.image_url = await uploadImageFal(inputs.image_path as string);
        }
        if (inputs.end_image_url) payload.end_image_url = inputs.end_image_url;
      }

      if (operation === "reference_to_video") {
        const refImageUrls: string[] = [...((inputs.reference_image_urls as string[]) ?? [])];
        for (const localPath of (inputs.reference_image_paths as string[]) ?? []) {
          refImageUrls.push(await uploadImageFal(localPath));
        }
        // Seedance 2.0 reference-to-video ceilings: 9 images + 3 video + 3 audio.
        if (refImageUrls.length > 9) {
          return toolResult({
            success: false,
            error: `Seedance 2.0 reference_to_video accepts at most 9 reference images; got ${refImageUrls.length}`,
          });
        }
        const refVideoUrls: string[] = [...((inputs.reference_video_urls as string[]) ?? [])];
        if (refVideoUrls.length > 3) {
          return toolResult({
            success: false,
            error: `Seedance 2.0 reference_to_video accepts at most 3 reference videos; got ${refVideoUrls.length}`,
          });
        }
        const refAudioUrls: string[] = [...((inputs.reference_audio_urls as string[]) ?? [])];
        if (refAudioUrls.length > 3) {
          return toolResult({
            success: false,
            error: `Seedance 2.0 reference_to_video accepts at most 3 reference audio clips; got ${refAudioUrls.length}`,
          });
        }
        if (refImageUrls.length > 0) payload.reference_image_urls = refImageUrls;
        if (refVideoUrls.length > 0) payload.reference_video_urls = refVideoUrls;
        if (refAudioUrls.length > 0) payload.reference_audio_urls = refAudioUrls;
      }

      const headers = {
        Authorization: `Key ${apiKey}`,
        "Content-Type": "application/json",
      };

      const submitResp = await fetch(`https://queue.fal.run/${modelPath}`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000),
      });
      if (!submitResp.ok) {
        const body = await submitResp.text().catch(() => "");
        throw new Error(`HTTP ${submitResp.status} ${submitResp.statusText}: ${body}`);
      }
      const queueData = (await submitResp.json()) as { status_url: string; response_url: string };
      const statusUrl = queueData.status_url;
      const responseUrl = queueData.response_url;

      for (;;) {
        await sleep(5000);
        const statusResp = await fetch(statusUrl, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(15000),
        });
        if (!statusResp.ok) {
          const body = await statusResp.text().catch(() => "");
          throw new Error(`HTTP ${statusResp.status} ${statusResp.statusText}: ${body}`);
        }
        const status = ((await statusResp.json()) as { status?: string }).status ?? "UNKNOWN";
        if (status === "COMPLETED") break;
        if (status === "FAILED" || status === "CANCELLED") {
          return toolResult({
            success: false,
            error: `Seedance 2.0 video generation ${status.toLowerCase()}`,
          });
        }
      }

      const resultResp = await fetch(responseUrl, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(30000),
      });
      if (!resultResp.ok) {
        const body = await resultResp.text().catch(() => "");
        throw new Error(`HTTP ${resultResp.status} ${resultResp.statusText}: ${body}`);
      }
      data = (await resultResp.json()) as Record<string, any>;

      const videoUrl = data.video.url as string;
      const videoResponse = await fetch(videoUrl, { signal: AbortSignal.timeout(120000) });
      if (!videoResponse.ok) {
        const body = await videoResponse.text().catch(() => "");
        throw new Error(`HTTP ${videoResponse.status} ${videoResponse.statusText}: ${body}`);
      }

      outputPath = (inputs.output_path as string) ?? "seedance_output.mp4";
      fs.mkdirSync(path.dirname(path.resolve(outputPath)) || ".", { recursive: true });
      fs.writeFileSync(outputPath, Buffer.from(await videoResponse.arrayBuffer()));
    } catch (e) {
      return toolResult({
        success: false,
        error: `Seedance 2.0 video generation failed: ${(e as Error).message ?? e}`,
      });
    }

    const probed = await probeOutput(outputPath);
    return toolResult({
      success: true,
      data: {
        provider: "seedance",
        model: modelPath,
        prompt: inputs.prompt,
        operation,
        variant,
        aspect_ratio: (inputs.aspect_ratio as string) ?? "16:9",
        resolution: (inputs.resolution as string) ?? "720p",
        generate_audio: (inputs.generate_audio as boolean) ?? true,
        seed: data.seed ?? null,
        output: outputPath,
        output_path: outputPath,
        format: "mp4",
        ...probed,
      },
      artifacts: [outputPath],
      cost_usd: this.estimateCost(inputs),
      duration_seconds: Math.round((Date.now() - start) / 10) / 100,
      model: modelPath,
    });
  }
}
