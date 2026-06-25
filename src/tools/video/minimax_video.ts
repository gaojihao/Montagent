/**
 * MiniMax (Hailuo AI) video generation via fal.ai API.
 *
 * TypeScript port of tools/video/minimax_video.py. Rewards prompt craft —
 * follows camera directions well and produces high-texture footage. execute()
 * is a real fetch-based translation of the Python `requests` calls: submit to
 * the fal.ai queue API, poll the status_url every 5s until COMPLETED, fetch the
 * result, and download the video.
 *
 * Parity notes vs. Python:
 *  - Python declared dependencies=[] and overrode get_status() to check
 *    FAL_KEY or FAL_AI_API_KEY. The TS port lists dependencies=["env:FAL_KEY"]
 *    (the documented key, for setup_offers) AND overrides getStatus() to
 *    preserve the FAL_AI_API_KEY fallback — behaviorally identical.
 *  - Model path construction (incl. the video-01 special cases), endpoints,
 *    headers, payload, poll cadence, terminal states, cost/runtime estimates,
 *    and the minimal result data dict (provider/model/prompt/output only — no
 *    ffprobe, matching the Python tool) all match verbatim.
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
  ToolStatus,
  ToolTier,
  toolResult,
} from "../base_tool.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class MiniMaxVideo extends BaseTool {
  override name = "minimax_video";
  override version = "0.1.0";
  override tier = ToolTier.GENERATE;
  override capability = "video_generation";
  override provider = "minimax";
  override stability = ToolStability.EXPERIMENTAL;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.STOCHASTIC;
  override runtime = ToolRuntime.API;

  override dependencies = ["env:FAL_KEY"];
  override install_instructions =
    "Set FAL_KEY to your fal.ai API key.\n" +
    "  Get one at https://fal.ai/dashboard/keys";
  override agent_skills = ["ai-video-gen"];

  override capabilities = ["text_to_video", "image_to_video"];
  override supports = {
    text_to_video: true,
    image_to_video: true,
    camera_direction: true,
  };
  override best_for = [
    "prompt-following with camera directions (framing, motion, composition)",
    "high-texture footage with minimal hallucination",
    "cost-effective video generation",
  ];
  override not_good_for = ["offline generation", "very long clips"];
  override fallback_tools = ["kling_video", "veo_video", "wan_video"];

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
        enum: [
          "video-01",
          "hailuo-02/pro",
          "hailuo-02/standard",
          "hailuo-2.3-fast/pro",
          "hailuo-2.3-fast/standard",
        ],
        default: "hailuo-02/pro",
      },
      image_url: {
        type: "string",
        description: "Reference image URL for image_to_video",
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
  override idempotency_key_fields = ["prompt", "model_variant", "operation"];
  override side_effects = [
    "writes video file to output_path",
    "calls fal.ai API",
  ];
  override user_visible_verification = [
    "Watch generated clip for motion coherence and prompt adherence",
  ];

  private getApiKey(): string | undefined {
    return process.env.FAL_KEY ?? process.env.FAL_AI_API_KEY;
  }

  override getStatus(): ToolStatus {
    return this.getApiKey() ? ToolStatus.AVAILABLE : ToolStatus.UNAVAILABLE;
  }

  override estimateCost(inputs: Record<string, unknown>): number {
    const variant = (inputs.model_variant as string) ?? "hailuo-02/pro";
    if (variant.includes("pro")) return 0.15;
    if (variant.includes("fast")) return 0.08;
    return 0.1; // standard
  }

  override estimateRuntime(inputs: Record<string, unknown>): number {
    const variant = (inputs.model_variant as string) ?? "hailuo-02/pro";
    if (variant.includes("fast")) return 30.0;
    return 60.0;
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
    const variant = (inputs.model_variant as string) ?? "hailuo-02/pro";

    // Build fal.ai model path
    let modelPath: string;
    if (operation === "text_to_video") {
      modelPath = `minimax/${variant}/text-to-video`;
      if (variant === "video-01") {
        modelPath = "minimax/video-01";
      }
    } else {
      modelPath = `minimax/${variant}/image-to-video`;
      if (variant === "video-01") {
        modelPath = "minimax/video-01/image-to-video";
      }
    }

    const payload: Record<string, unknown> = { prompt: inputs.prompt };
    if (operation === "image_to_video" && inputs.image_url) {
      payload.image_url = inputs.image_url;
    }

    const headers = {
      Authorization: `Key ${apiKey}`,
      "Content-Type": "application/json",
    };

    let outputPath: string;
    try {
      // Submit to queue API (async) — sync endpoint times out for video gen
      const submitResp = await fetch(`https://queue.fal.run/fal-ai/${modelPath}`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000),
      });
      await raiseForStatus(submitResp);
      const queueData = (await submitResp.json()) as {
        status_url: string;
        response_url: string;
      };
      const statusUrl = queueData.status_url;
      const responseUrl = queueData.response_url;

      // Poll until complete
      for (;;) {
        await sleep(5000);
        const statusResp = await fetch(statusUrl, {
          headers,
          signal: AbortSignal.timeout(15000),
        });
        await raiseForStatus(statusResp);
        const status =
          ((await statusResp.json()) as { status?: string }).status ?? "UNKNOWN";
        if (status === "COMPLETED") break;
        if (status === "FAILED" || status === "CANCELLED") {
          return toolResult({
            success: false,
            error: `MiniMax video generation ${status.toLowerCase()}`,
          });
        }
      }

      // Fetch result
      const resultResp = await fetch(responseUrl, {
        headers,
        signal: AbortSignal.timeout(30000),
      });
      await raiseForStatus(resultResp);
      const data = (await resultResp.json()) as { video: { url: string } };

      const videoUrl = data.video.url;
      const videoResponse = await fetch(videoUrl, {
        signal: AbortSignal.timeout(120000),
      });
      await raiseForStatus(videoResponse);

      outputPath = path.resolve((inputs.output_path as string) ?? "minimax_output.mp4");
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, Buffer.from(await videoResponse.arrayBuffer()));
    } catch (e) {
      return toolResult({
        success: false,
        error: `MiniMax video generation failed: ${(e as Error).message ?? e}`,
      });
    }

    return toolResult({
      success: true,
      data: {
        provider: "minimax",
        model: `fal-ai/${modelPath}`,
        prompt: inputs.prompt,
        output: outputPath,
      },
      artifacts: [outputPath],
      cost_usd: this.estimateCost(inputs),
      duration_seconds: Math.round((Date.now() - start) / 10) / 100,
      model: `fal-ai/${modelPath}`,
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
