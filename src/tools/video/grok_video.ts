/**
 * xAI Grok Imagine video generation with native synchronized audio.
 *
 * TypeScript port of tools/video/grok_video.py. Generates 1-15 second videos
 * with synchronized sound (dialogue with lip-sync, SFX, ambient, background
 * music) in a single pass — no post-production audio needed. execute() is a
 * real fetch-based translation of the Python `requests` calls: POST a
 * generation, poll /v1/videos/{request_id} until status == "done", download the
 * video, and probe it with ffprobe (via the shared probeOutput helper).
 *
 * Parity notes vs. Python:
 *  - Python declared dependencies=[] and overrode get_status() to check
 *    XAI_API_KEY. The TS port uses dependencies=["env:XAI_API_KEY"] so the base
 *    getStatus() drives availability — behaviorally identical and keeps the
 *    grok entry in setup_offers.
 *  - _file_to_data_uri / _normalize_media_ref, _build_payload (incl. the
 *    reference_to_video branch that omits duration/aspect/resolution from the
 *    top level then re-adds them), resolution normalization (540p -> 480p),
 *    input-image cost accounting, poll cadence, terminal states (done/failed/
 *    expired), per-request timeouts, and the result data dict all match verbatim.
 *  - Per-request `requests` timeouts are translated to AbortSignal.timeout
 *    (matching the sibling veo_video port convention).
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

function normalizeMediaRef(
  urlValue: string | undefined,
  pathValue: string | undefined
): { url: string } | null {
  if (urlValue) return { url: urlValue };
  if (pathValue) return { url: fileToDataUri(pathValue) };
  return null;
}

export class GrokVideo extends BaseTool {
  override name = "grok_video";
  override version = "0.1.0";
  override tier = ToolTier.GENERATE;
  override capability = "video_generation";
  override provider = "grok";
  override stability = ToolStability.BETA;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.STOCHASTIC;
  override runtime = ToolRuntime.API;

  override dependencies = ["env:XAI_API_KEY"];
  override install_instructions =
    "Set XAI_API_KEY to your xAI API key.\n" +
    "  Get one from the xAI developer console";
  override agent_skills = ["grok-media", "ai-video-gen"];

  override capabilities = [
    "text_to_video",
    "image_to_video",
    "reference_to_video",
  ];
  override supports = {
    text_to_video: true,
    image_to_video: true,
    reference_to_video: true,
    reference_image: true,
    multiple_reference_images: true,
    native_audio: true,
    lip_sync: true,
    cinematic_quality: true,
  };
  override best_for = [
    "cinematic clips with native synchronized audio (dialogue, SFX, music)",
    "reference-conditioned video with product/character consistency",
    "lip-synced dialogue and foley in a single generation pass",
    "cost-effective high-quality video ($0.07/s at 720p)",
  ];
  override not_good_for = ["offline generation"];
  override fallback_tools = [
    "veo_video",
    "runway_video",
    "kling_video",
    "minimax_video",
  ];

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
      model: {
        type: "string",
        enum: ["grok-imagine-video"],
        default: "grok-imagine-video",
      },
      duration: {
        type: "integer",
        minimum: 1,
        maximum: 15,
        default: 5,
      },
      aspect_ratio: {
        type: "string",
        enum: ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"],
        default: "16:9",
      },
      resolution: {
        type: "string",
        enum: ["480p", "720p"],
        default: "720p",
      },
      image_url: {
        type: "string",
        description: "Reference image URL for image_to_video",
      },
      image_path: {
        type: "string",
        description: "Local reference image path for image_to_video",
      },
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
      output_path: { type: "string" },
      poll_interval_seconds: { type: "integer", minimum: 2, default: 5 },
      timeout_seconds: { type: "integer", minimum: 30, default: 900 },
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
  override idempotency_key_fields = [
    "prompt",
    "operation",
    "model",
    "duration",
    "aspect_ratio",
    "resolution",
  ];
  override side_effects = [
    "writes video file to output_path",
    "calls xAI video API",
  ];
  override user_visible_verification = [
    "Watch generated clip for motion quality and prompt fidelity",
  ];

  private static normalizeResolution(value: string | undefined): string {
    if (value === "540p") return "480p";
    return value || "720p";
  }

  private static inputImageCount(inputs: Record<string, unknown>): number {
    let count = 0;
    if (inputs.image_url || inputs.image_path) count += 1;
    count += ((inputs.reference_image_urls as unknown[]) ?? []).length;
    count += ((inputs.reference_image_paths as unknown[]) ?? []).length;
    return count;
  }

  override estimateCost(inputs: Record<string, unknown>): number {
    const duration = parseInt(String(inputs.duration ?? 5), 10);
    const resolution = GrokVideo.normalizeResolution(
      inputs.resolution as string | undefined
    );
    const basePerSecond = resolution === "720p" ? 0.07 : 0.05;
    const inputImageCost = GrokVideo.inputImageCount(inputs) * 0.002;
    // xAI currently publishes Grok Imagine Video at $0.05/sec for 480p,
    // $0.07/sec for 720p, plus $0.002 per input image.
    return basePerSecond * duration + inputImageCost;
  }

  override estimateRuntime(inputs: Record<string, unknown>): number {
    const duration = parseInt(String(inputs.duration ?? 5), 10);
    return 90.0 + duration * 8.0;
  }

  private buildPayload(inputs: Record<string, unknown>): Record<string, unknown> {
    const operation = (inputs.operation as string) ?? "text_to_video";
    const payload: Record<string, unknown> = {
      model: (inputs.model as string) ?? "grok-imagine-video",
      prompt: inputs.prompt,
    };

    if (operation !== "reference_to_video") {
      payload.duration = parseInt(String(inputs.duration ?? 5), 10);
      if (inputs.aspect_ratio) payload.aspect_ratio = inputs.aspect_ratio;
      if (inputs.resolution) {
        payload.resolution = GrokVideo.normalizeResolution(
          inputs.resolution as string
        );
      }
    }

    if (operation === "image_to_video") {
      const image = normalizeMediaRef(
        inputs.image_url as string | undefined,
        inputs.image_path as string | undefined
      );
      if (!image) {
        throw new Error("image_to_video requires image_url or image_path");
      }
      payload.image = image;
    } else if (operation === "reference_to_video") {
      const refs: Array<{ url: string }> = (
        (inputs.reference_image_urls as string[]) ?? []
      ).map((url) => ({ url }));
      for (const p of (inputs.reference_image_paths as string[]) ?? []) {
        refs.push({ url: fileToDataUri(p) });
      }
      if (refs.length === 0) {
        throw new Error(
          "reference_to_video requires reference_image_urls or reference_image_paths"
        );
      }
      payload.reference_images = refs;
      payload.duration = parseInt(String(inputs.duration ?? 5), 10);
      if (inputs.aspect_ratio) payload.aspect_ratio = inputs.aspect_ratio;
      if (inputs.resolution) {
        payload.resolution = GrokVideo.normalizeResolution(
          inputs.resolution as string
        );
      }
    }

    return payload;
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
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };

    let payload: Record<string, unknown>;
    let requestId: string;
    let outputPath: string;
    try {
      payload = this.buildPayload(inputs);
      const response = await fetch("https://api.x.ai/v1/videos/generations", {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(60000),
      });
      await raiseForStatus(response);
      requestId = ((await response.json()) as { request_id: string }).request_id;

      const timeoutSeconds = parseInt(String(inputs.timeout_seconds ?? 900), 10);
      const pollInterval = parseInt(String(inputs.poll_interval_seconds ?? 5), 10);
      const deadline = Date.now() + timeoutSeconds * 1000;

      let resultData: Record<string, unknown> | null = null;
      while (Date.now() < deadline) {
        const result = await fetch(`https://api.x.ai/v1/videos/${requestId}`, {
          headers: { Authorization: headers.Authorization },
          signal: AbortSignal.timeout(30000),
        });
        await raiseForStatus(result);
        resultData = (await result.json()) as Record<string, unknown>;
        const status = resultData.status;
        if (status === "done") break;
        if (status === "failed" || status === "expired") {
          const detail =
            resultData.error ?? resultData.message ?? status;
          return toolResult({
            success: false,
            error: `Grok video generation ${status}: ${detail}`,
          });
        }
        await sleep(pollInterval * 1000);
      }

      if (!resultData || resultData.status !== "done") {
        return toolResult({
          success: false,
          error: "Grok video generation timed out",
        });
      }

      const videoUrl = (
        (resultData.video as { url?: string } | undefined) ?? {}
      ).url;
      if (!videoUrl) {
        return toolResult({
          success: false,
          error: "xAI video output missing url",
        });
      }

      const download = await fetch(videoUrl, {
        signal: AbortSignal.timeout(300000),
      });
      await raiseForStatus(download);
      outputPath = path.resolve(
        (inputs.output_path as string) ?? "grok_video_output.mp4"
      );
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, Buffer.from(await download.arrayBuffer()));
    } catch (e) {
      return toolResult({
        success: false,
        error: `Grok video generation failed: ${(e as Error).message ?? e}`,
      });
    }

    const probed = await probeOutput(outputPath);
    return toolResult({
      success: true,
      data: {
        provider: "grok",
        model: payload.model,
        prompt: inputs.prompt,
        operation: (inputs.operation as string) ?? "text_to_video",
        request_id: requestId,
        output: outputPath,
        output_path: outputPath,
        format: "mp4",
        ...probed,
      },
      artifacts: [outputPath],
      cost_usd: this.estimateCost(inputs),
      duration_seconds: Math.round((Date.now() - start) / 10) / 100,
      model: payload.model as string,
    });
  }
}

/** Mirror requests.raise_for_status(): non-2xx -> throw status + body. */
async function raiseForStatus(response: Response): Promise<void> {
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${body}`);
  }
}
