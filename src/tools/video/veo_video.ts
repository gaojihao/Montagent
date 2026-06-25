/**
 * Google Veo 3.1 video generation via fal.ai API.
 *
 * Supports text-to-video, image-to-video, reference-to-video, and
 * first/last-frame interpolation so agents can preserve visual consistency
 * instead of relying only on raw text prompts.
 *
 * TypeScript port of tools/video/veo_video.py. execute() is a real fetch-based
 * translation of the Python requests flow: submit to the fal.ai queue, poll
 * status_url every 5s until COMPLETED, fetch response_url, then download the
 * returned video. Local image inputs are inlined as base64 data URIs (matching
 * the Python _file_to_data_uri helper).
 *
 * Parity notes vs. Python:
 *  - Python declared dependencies=[] and overrode get_status() to accept either
 *    FAL_KEY or FAL_AI_API_KEY. The TS port declares
 *    dependencies=["env:FAL_KEY"] so the base getStatus() drives preflight
 *    availability, while execute() still accepts either env var via getApiKey().
 *  - Duration guard for image-guided veo3.1, model-path map, payload assembly,
 *    data-URI normalization, poll loop, cost/runtime estimates, and result
 *    fields all match the Python verbatim.
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Minimal extension -> MIME map mirroring Python's mimetypes.guess_type for the
// image/video types this tool accepts; falls back to application/octet-stream.
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

export class VeoVideo extends BaseTool {
  override name = "veo_video";
  override version = "0.1.0";
  override tier = ToolTier.GENERATE;
  override capability = "video_generation";
  override provider = "veo";
  override stability = ToolStability.EXPERIMENTAL;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.STOCHASTIC;
  override runtime = ToolRuntime.API;

  override dependencies = ["env:FAL_KEY"];
  override install_instructions =
    "Set FAL_KEY or FAL_AI_API_KEY to your fal.ai API key.\n" +
    "  Get one at https://fal.ai/dashboard/keys";
  override agent_skills = ["ai-video-gen"];

  override capabilities = [
    "text_to_video",
    "image_to_video",
    "reference_to_video",
    "first_last_frame_to_video",
  ];
  override supports = {
    text_to_video: true,
    image_to_video: true,
    reference_to_video: true,
    first_last_frame_to_video: true,
    native_audio: true,
    dialogue_generation: true,
    ambient_sound: true,
  };
  override best_for = [
    "videos with synchronized dialogue and audio",
    "cutting-edge quality from Google DeepMind",
    "ambient sound and music generation built in",
  ];
  override not_good_for = ["budget projects", "offline generation", "quick iteration"];
  override fallback_tools = ["kling_video", "minimax_video", "wan_video"];

  override input_schema = {
    type: "object",
    required: ["prompt"],
    properties: {
      prompt: { type: "string" },
      operation: {
        type: "string",
        enum: [
          "text_to_video",
          "image_to_video",
          "reference_to_video",
          "first_last_frame_to_video",
        ],
        default: "text_to_video",
      },
      model_variant: {
        type: "string",
        enum: ["veo3", "veo3/fast", "veo3.1", "veo3.1/fast"],
        default: "veo3.1",
      },
      duration: {
        type: "string",
        enum: ["4s", "6s", "8s"],
        default: "8s",
        description: "Duration in seconds",
      },
      aspect_ratio: {
        type: "string",
        enum: ["16:9", "9:16"],
        default: "16:9",
      },
      generate_audio: {
        type: "boolean",
        default: true,
        description: "Whether to generate synchronized audio",
      },
      resolution: {
        type: "string",
        enum: ["720p", "1080p", "4k"],
        default: "1080p",
      },
      negative_prompt: { type: "string" },
      seed: { type: "integer" },
      auto_fix: { type: "boolean", default: true },
      safety_tolerance: {
        type: "string",
        enum: ["1", "2", "3", "4", "5", "6"],
        default: "4",
      },
      image_url: { type: "string", description: "Reference image URL for image_to_video" },
      image_path: { type: "string", description: "Local reference image path for image_to_video" },
      reference_image_urls: {
        type: "array",
        items: { type: "string" },
        description: "Reference image URLs for reference_to_video",
      },
      reference_image_paths: {
        type: "array",
        items: { type: "string" },
        description: "Local reference image paths for reference_to_video",
      },
      first_frame_url: { type: "string" },
      first_frame_path: { type: "string" },
      last_frame_url: { type: "string" },
      last_frame_path: { type: "string" },
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
  override idempotency_key_fields = ["prompt", "model_variant", "operation", "duration"];
  override side_effects = [
    "writes video file to output_path",
    "calls fal.ai API",
  ];
  override user_visible_verification = [
    "Watch generated clip for visual quality and motion",
    "Listen for audio synchronization and quality",
  ];

  private getApiKey(): string | undefined {
    return process.env.FAL_KEY ?? process.env.FAL_AI_API_KEY;
  }

  override estimateCost(inputs: Record<string, unknown>): number {
    const variant = (inputs.model_variant as string) ?? "veo3.1";
    const durationText = String((inputs.duration as string) ?? "8s").replace(/s/g, "");
    const duration = parseInt(durationText, 10);
    const resolution = (inputs.resolution as string) ?? "1080p";
    const generateAudio =
      inputs.generate_audio === undefined ? true : Boolean(inputs.generate_audio);

    let basePerSecond: number;
    let audioPerSecond: number;
    if (variant.includes("fast")) {
      basePerSecond = 0.1;
      audioPerSecond = 0.2;
    } else if (resolution === "4k") {
      basePerSecond = 0.4;
      audioPerSecond = 0.6;
    } else {
      basePerSecond = 0.2;
      audioPerSecond = 0.4;
    }

    return (generateAudio ? audioPerSecond : basePerSecond) * duration;
  }

  override estimateRuntime(inputs: Record<string, unknown>): number {
    const variant = (inputs.model_variant as string) ?? "veo3.1";
    if (variant.includes("fast")) return 45.0;
    return 120.0;
  }

  private static fileToDataUri(pathStr: string): string {
    if (!fs.existsSync(pathStr)) {
      throw new Error(`Input file not found: ${pathStr}`);
    }
    const ext = path.extname(pathStr).toLowerCase();
    const mimeType = MIME_BY_EXT[ext] ?? "application/octet-stream";
    const encoded = fs.readFileSync(pathStr).toString("base64");
    return `data:${mimeType};base64,${encoded}`;
  }

  private normalizeFileInput(
    urlValue: string | undefined,
    pathValue: string | undefined
  ): string | null {
    if (urlValue) return urlValue;
    if (pathValue) return VeoVideo.fileToDataUri(pathValue);
    return null;
  }

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      return toolResult({
        success: false,
        error: "FAL_KEY / FAL_AI_API_KEY not set. " + this.install_instructions,
      });
    }

    const start = Date.now();
    const operation = (inputs.operation as string) ?? "text_to_video";
    const variant = (inputs.model_variant as string) ?? "veo3.1";
    const duration = (inputs.duration as string) ?? "8s";

    // Current fal Veo 3.1 image-guided endpoints only accept 8-second clips.
    if (
      variant === "veo3.1" &&
      (operation === "reference_to_video" || operation === "first_last_frame_to_video") &&
      duration !== "8s"
    ) {
      return toolResult({
        success: false,
        error:
          `${operation} with ${variant} currently requires duration='8s' on fal.ai; ` +
          `received duration='${duration}'`,
      });
    }

    // Build fal.ai model path
    const operationMap: Record<string, string> = {
      text_to_video: variant,
      image_to_video: `${variant}/image-to-video`,
      reference_to_video: `${variant}/reference-to-video`,
      first_last_frame_to_video: `${variant}/first-last-frame-to-video`,
    };
    const modelPath = operationMap[operation]!;

    const payload: Record<string, unknown> = { prompt: inputs.prompt };
    if (inputs.duration) payload.duration = inputs.duration;
    if (inputs.aspect_ratio) payload.aspect_ratio = inputs.aspect_ratio;
    if (inputs.resolution) payload.resolution = inputs.resolution;
    if (inputs.generate_audio != null) payload.generate_audio = inputs.generate_audio;
    if (inputs.negative_prompt) payload.negative_prompt = inputs.negative_prompt;
    if (inputs.seed != null) payload.seed = inputs.seed;
    if (inputs.auto_fix != null) payload.auto_fix = inputs.auto_fix;
    if (inputs.safety_tolerance) payload.safety_tolerance = inputs.safety_tolerance;

    let data: Record<string, any>;
    let outputPath: string;

    try {
      if (operation === "image_to_video") {
        const imageValue = this.normalizeFileInput(
          inputs.image_url as string | undefined,
          inputs.image_path as string | undefined
        );
        if (!imageValue) {
          return toolResult({
            success: false,
            error: "image_to_video requires image_url or image_path",
          });
        }
        payload.image_url = imageValue;
      }

      if (operation === "reference_to_video") {
        const imageUrls: string[] = [...((inputs.reference_image_urls as string[]) ?? [])];
        const imagePaths: string[] = [...((inputs.reference_image_paths as string[]) ?? [])];
        const normalized: string[] = [...imageUrls];
        for (const p of imagePaths) normalized.push(VeoVideo.fileToDataUri(p));
        if (normalized.length === 0) {
          return toolResult({
            success: false,
            error: "reference_to_video requires reference_image_urls or reference_image_paths",
          });
        }
        payload.image_urls = normalized;
      }

      if (operation === "first_last_frame_to_video") {
        const firstFrame = this.normalizeFileInput(
          inputs.first_frame_url as string | undefined,
          inputs.first_frame_path as string | undefined
        );
        const lastFrame = this.normalizeFileInput(
          inputs.last_frame_url as string | undefined,
          inputs.last_frame_path as string | undefined
        );
        if (!firstFrame || !lastFrame) {
          return toolResult({
            success: false,
            error:
              "first_last_frame_to_video requires first_frame_url/path and last_frame_url/path",
          });
        }
        payload.first_frame_url = firstFrame;
        payload.last_frame_url = lastFrame;
      }

      const headers = {
        Authorization: `Key ${apiKey}`,
        "Content-Type": "application/json",
      };

      // Submit to queue API (async) — sync endpoint times out for video gen
      const submitResp = await fetch(`https://queue.fal.run/fal-ai/${modelPath}`, {
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

      // Poll until complete
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
            error: `Veo video generation ${status.toLowerCase()}`,
          });
        }
      }

      // Fetch result
      const resultResp = await fetch(responseUrl, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(30000),
      });
      if (!resultResp.ok) {
        const detail = (await resultResp.text().catch(() => "")).slice(0, 1000);
        return toolResult({
          success: false,
          error: `Veo video generation result fetch failed (${resultResp.status}): ${detail}`,
        });
      }
      data = (await resultResp.json()) as Record<string, any>;

      const videoUrl = data.video.url as string;
      const videoResponse = await fetch(videoUrl, { signal: AbortSignal.timeout(120000) });
      if (!videoResponse.ok) {
        const body = await videoResponse.text().catch(() => "");
        throw new Error(`HTTP ${videoResponse.status} ${videoResponse.statusText}: ${body}`);
      }

      outputPath = (inputs.output_path as string) ?? "veo_output.mp4";
      fs.mkdirSync(path.dirname(path.resolve(outputPath)) || ".", { recursive: true });
      fs.writeFileSync(outputPath, Buffer.from(await videoResponse.arrayBuffer()));
    } catch (e) {
      return toolResult({
        success: false,
        error: `Veo video generation failed: ${(e as Error).message ?? e}`,
      });
    }

    return toolResult({
      success: true,
      data: {
        provider: "veo",
        model: `fal-ai/${modelPath}`,
        prompt: inputs.prompt,
        output: outputPath,
        has_audio: (inputs.generate_audio as boolean) ?? true,
        operation,
      },
      artifacts: [outputPath],
      cost_usd: this.estimateCost(inputs),
      duration_seconds: Math.round((Date.now() - start) / 10) / 100,
      model: `fal-ai/${modelPath}`,
    });
  }
}
