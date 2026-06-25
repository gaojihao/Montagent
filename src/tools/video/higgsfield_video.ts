/**
 * Higgsfield video generation via Higgsfield Cloud API.
 *
 * TypeScript port of tools/video/higgsfield_video.py. Multi-model orchestrator
 * with proprietary Soul model for character-consistent, photorealistic video
 * generation. Routes to Kling, Veo, Sora, and WAN under the hood. execute() is
 * a real fetch-based translation of the Python `requests` calls: submit a
 * generation, poll the status_url (max 72 iterations, 5s apart) until Completed,
 * download the video, and probe it with ffprobe (via the shared probeOutput).
 *
 * Parity notes vs. Python:
 *  - Python declared dependencies=[] and overrode get_status() via
 *    _get_credentials(). The TS port lists dependencies=["env:HIGGSFIELD_API_KEY"]
 *    (representative, for setup_offers) AND overrides getStatus() with the full
 *    credential logic (combined HIGGSFIELD_KEY=key:secret OR
 *    HIGGSFIELD_API_KEY+HIGGSFIELD_API_SECRET) — behaviorally identical.
 *  - Endpoints, headers, payload shape (task = operation with "_"->"-"),
 *    poll cadence/count, terminal states, the execute()-side default model
 *    "kling_3.0" (distinct from the schema default "seedance_2.0"), cost/runtime
 *    estimates, and the result data dict all match verbatim.
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
import { probeOutput } from "./_shared.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class HiggsFieldVideo extends BaseTool {
  override name = "higgsfield_video";
  override version = "0.1.0";
  override tier = ToolTier.GENERATE;
  override capability = "video_generation";
  override provider = "higgsfield";
  override stability = ToolStability.EXPERIMENTAL;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.STOCHASTIC;
  override runtime = ToolRuntime.API;

  override dependencies = ["env:HIGGSFIELD_API_KEY"];
  override install_instructions =
    "Set HIGGSFIELD_API_KEY and HIGGSFIELD_API_SECRET for your Higgsfield Cloud credentials.\n" +
    "  Get them at https://cloud.higgsfield.ai/api-keys\n" +
    "  Alternatively, set HIGGSFIELD_KEY as a combined key:secret value.";
  override agent_skills = ["seedance-2-0", "ai-video-gen"];

  override capabilities = ["text_to_video", "image_to_video"];
  override supports = {
    text_to_video: true,
    image_to_video: true,
    character_consistency: true,
    multi_model_routing: true,
    native_audio: true,
    cinematic_quality: true,
    camera_direction: true,
    lip_sync: true,
    multi_shot: true,
  };
  override best_for = [
    "preferred premium video gen on Higgsfield (Seedance 2.0 is the default model)",
    "cinematic trailers, teasers, and high-fidelity clips with native synchronized audio",
    "character-consistent video generation (Soul ID + Seedance 2.0 identity consistency)",
    "director-level camera control and multi-shot editing in a single generation",
    "lip-sync from quoted dialogue in prompts",
    "multi-model access through a single API (Seedance 2.0, Kling, Veo, Sora, WAN)",
  ];
  override not_good_for = [
    "offline generation",
    "fine-grained model control",
    "budget projects without subscription",
  ];
  override fallback_tools = [
    "seedance_video",
    "seedance_replicate",
    "kling_video",
    "veo_video",
    "minimax_video",
  ];
  override quality_score = 0.9;

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
      model: {
        type: "string",
        enum: [
          "seedance_2.0",
          "seedance_2.0_fast",
          "kling_3.0",
          "veo_3.1",
          "sora_2",
          "wan_2.5",
          "soul_cinema",
        ],
        default: "seedance_2.0",
        description:
          "Underlying model. Defaults to Seedance 2.0 (preferred premium) — see .agents/skills/seedance-2-0/",
      },
      duration: {
        type: "string",
        enum: ["5", "10", "15"],
        default: "5",
        description: "Duration in seconds (availability varies by model)",
      },
      aspect_ratio: {
        type: "string",
        enum: ["16:9", "9:16", "1:1", "21:9"],
        default: "16:9",
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
  override idempotency_key_fields = [
    "prompt",
    "model",
    "operation",
    "duration",
  ];
  override side_effects = [
    "writes video file to output_path",
    "calls Higgsfield Cloud API",
  ];
  override user_visible_verification = [
    "Watch generated clip for motion coherence and visual quality",
  ];

  /** Return [api_key, api_secret] or null if not configured. */
  private getCredentials(): [string, string] | null {
    const combined = process.env.HIGGSFIELD_KEY;
    if (combined && combined.includes(":")) {
      const idx = combined.indexOf(":");
      return [combined.slice(0, idx), combined.slice(idx + 1)];
    }
    const key = process.env.HIGGSFIELD_API_KEY;
    const secret = process.env.HIGGSFIELD_API_SECRET;
    if (key && secret) return [key, secret];
    return null;
  }

  override getStatus(): ToolStatus {
    return this.getCredentials()
      ? ToolStatus.AVAILABLE
      : ToolStatus.UNAVAILABLE;
  }

  override estimateCost(inputs: Record<string, unknown>): number {
    const model = (inputs.model as string) ?? "seedance_2.0";
    const duration = parseInt((inputs.duration as string) ?? "5", 10);
    // Approximate per-clip costs based on Higgsfield credit pricing.
    // Seedance 2.0 on Higgsfield runs ~50-80 credits per 5s clip ≈ $0.50-$1.20.
    const baseCosts: Record<string, number> = {
      "seedance_2.0": 0.8,
      "seedance_2.0_fast": 0.5,
      "kling_3.0": 0.1,
      "wan_2.5": 0.1,
      "veo_3.1": 0.5,
      "sora_2": 0.5,
      soul_cinema: 0.15,
    };
    const base = baseCosts[model] ?? 0.15;
    return base * (duration / 5);
  }

  override estimateRuntime(inputs: Record<string, unknown>): number {
    const model = (inputs.model as string) ?? "seedance_2.0";
    if (model === "veo_3.1" || model === "sora_2" || model === "seedance_2.0") {
      return 120.0;
    }
    if (model === "seedance_2.0_fast") {
      return 60.0;
    }
    return 60.0;
  }

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const creds = this.getCredentials();
    if (!creds) {
      return toolResult({
        success: false,
        error:
          "Higgsfield credentials not set. " + this.install_instructions,
      });
    }

    const [apiKey, apiSecret] = creds;
    const start = Date.now();
    const operation = (inputs.operation as string) ?? "text_to_video";
    const model = (inputs.model as string) ?? "kling_3.0";

    const payload: Record<string, unknown> = {
      prompt: inputs.prompt,
      model,
      task: operation.replace(/_/g, "-"),
    };
    if (inputs.duration) payload.duration = parseInt(inputs.duration as string, 10);
    if (inputs.aspect_ratio) payload.aspect_ratio = inputs.aspect_ratio;
    if (operation === "image_to_video" && inputs.image_url) {
      payload.image_url = inputs.image_url;
    }

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "X-API-Secret": apiSecret,
      "Content-Type": "application/json",
    };

    let outputPath: string;
    try {
      // Submit generation request
      const submitResp = await fetch(
        "https://platform.higgsfield.ai/v1/generations",
        {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(30000),
        }
      );
      await raiseForStatus(submitResp);
      const genData = (await submitResp.json()) as {
        id: string;
        status_url?: string;
      };
      const generationId = genData.id;
      const statusUrl =
        genData.status_url ??
        `https://platform.higgsfield.ai/v1/generations/${generationId}`;

      // Poll for completion
      let videoUrl: string | undefined;
      for (let i = 0; i < 72; i++) {
        // max ~6 minutes
        await sleep(5000);
        const pollResp = await fetch(statusUrl, {
          headers,
          signal: AbortSignal.timeout(15000),
        });
        await raiseForStatus(pollResp);
        const pollData = (await pollResp.json()) as {
          status?: string;
          output_url?: string;
          url?: string;
          error?: string;
        };
        const status = pollData.status ?? "Unknown";

        if (status === "Completed" || status === "COMPLETED") {
          videoUrl = pollData.output_url ?? pollData.url;
          break;
        }
        if (
          status === "Failed" ||
          status === "FAILED" ||
          status === "NSFW" ||
          status === "Cancelled" ||
          status === "CANCELLED"
        ) {
          return toolResult({
            success: false,
            error: `Higgsfield generation ${status}: ${pollData.error ?? "unknown"}`,
          });
        }
      }

      if (!videoUrl) {
        return toolResult({
          success: false,
          error: "Higgsfield generation timed out.",
        });
      }

      // Download video
      const videoResponse = await fetch(videoUrl, {
        signal: AbortSignal.timeout(120000),
      });
      await raiseForStatus(videoResponse);

      outputPath = path.resolve(
        (inputs.output_path as string) ?? "higgsfield_output.mp4"
      );
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, Buffer.from(await videoResponse.arrayBuffer()));
    } catch (e) {
      return toolResult({
        success: false,
        error: `Higgsfield video generation failed: ${(e as Error).message ?? e}`,
      });
    }

    const probed = await probeOutput(outputPath);
    return toolResult({
      success: true,
      data: {
        provider: "higgsfield",
        model,
        prompt: inputs.prompt,
        operation,
        aspect_ratio: (inputs.aspect_ratio as string) ?? "16:9",
        output: outputPath,
        output_path: outputPath,
        format: "mp4",
        ...probed,
      },
      artifacts: [outputPath],
      cost_usd: this.estimateCost(inputs),
      duration_seconds: Math.round((Date.now() - start) / 10) / 100,
      model,
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
