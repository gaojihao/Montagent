/**
 * Runway Gen-4 video generation via Runway API.
 *
 * Highest Elo-rated video generation model — professional quality and control.
 * Supports Gen-3 Alpha Turbo, Gen-4 Turbo, and Gen-4 Aleph (highest fidelity).
 *
 * TypeScript port of tools/video/runway_video.py. execute() is a real
 * fetch-based translation of the Python requests flow: submit a generation
 * task, poll /tasks/{id} every 5s (up to 60 times ≈ 5 minutes), then download
 * the ephemeral output URL.
 *
 * Parity notes vs. Python:
 *  - Python declared dependencies=[] and overrode get_status() to accept either
 *    RUNWAY_API_KEY or RUNWAYML_API_SECRET. The TS port declares
 *    dependencies=["env:RUNWAY_API_KEY"] so the base getStatus() drives preflight
 *    availability, while execute() still accepts either env var via getApiKey().
 *  - Ratio map, cost-per-second / runtime tables, endpoints, headers
 *    (X-Runway-Version: 2024-11-06), payload, poll loop, and result fields all
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
import { probeOutput } from "./_shared.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const RATIO_MAP: Record<string, string> = {
  "16:9": "1280:720",
  "9:16": "720:1280",
  "1:1": "720:720",
};

const COST_PER_SECOND: Record<string, number> = {
  gen3a_turbo: 0.05,
  gen4_turbo: 0.05,
  gen4_aleph: 0.15,
  // Third-party Seedance 2.0 inside Runway (Enterprise/Unlimited, non-US).
  "seedance_2.0": 0.3,
  "seedance_2.0_fast": 0.24,
};

const RUNTIME_SECONDS: Record<string, number> = {
  gen3a_turbo: 25.0,
  gen4_turbo: 30.0,
  gen4_aleph: 60.0,
  "seedance_2.0": 120.0,
  "seedance_2.0_fast": 60.0,
};

export class RunwayVideo extends BaseTool {
  override name = "runway_video";
  override version = "0.2.0";
  override tier = ToolTier.GENERATE;
  override capability = "video_generation";
  override provider = "runway";
  override stability = ToolStability.BETA;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.STOCHASTIC;
  override runtime = ToolRuntime.API;

  override dependencies = ["env:RUNWAY_API_KEY"];
  override install_instructions =
    "Set RUNWAY_API_KEY to your Runway API secret.\n" +
    "  Get one at https://dev.runwayml.com/";
  override agent_skills = ["seedance-2-0", "ai-video-gen"];

  override capabilities = ["text_to_video", "image_to_video"];
  override supports = {
    text_to_video: true,
    image_to_video: true,
    professional_control: true,
    native_audio: true,
    cinematic_quality: true,
    camera_direction: true,
    lip_sync: true,
    multi_shot: true,
  };
  override best_for = [
    "preferred premium video gen on Runway when Seedance 2.0 model is selected",
    "cinematic trailers, teasers, and high-fidelity clips with native synchronized audio (Seedance 2.0 path)",
    "director-level camera control and multi-shot editing (Seedance 2.0) or Runway Gen-4 professional control",
    "lip-sync from quoted dialogue in prompts (Seedance 2.0)",
    "professional video production",
  ];
  override not_good_for = ["budget projects", "offline generation", "very long clips"];
  override fallback_tools = [
    "seedance_video",
    "seedance_replicate",
    "kling_video",
    "veo_video",
    "minimax_video",
    "wan_video",
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
        enum: ["seedance_2.0", "seedance_2.0_fast", "gen4_turbo", "gen4_aleph", "gen3a_turbo"],
        default: "seedance_2.0",
        description:
          "seedance_2.0 = preferred premium default (single-pass synced audio, multi-shot, lip-sync — " +
          "Runway Unlimited/Enterprise plan, non-US only). " +
          "seedance_2.0_fast = lower-cost Seedance variant. " +
          "gen4_aleph = Runway's highest-fidelity native model. " +
          "gen4_turbo = balanced Runway native. " +
          "gen3a_turbo = cheapest Runway native.",
      },
      duration: {
        type: "integer",
        enum: [5, 10],
        default: 5,
        description: "Duration in seconds",
      },
      ratio: {
        type: "string",
        enum: ["16:9", "9:16", "1:1"],
        default: "16:9",
      },
      watermark: {
        type: "boolean",
        default: false,
        description: "Include Runway watermark on output",
      },
      image_url: { type: "string", description: "Reference image URL for image_to_video" },
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
    retryable_errors: ["rate_limit", "timeout", "THROTTLED"],
  };
  override idempotency_key_fields = ["prompt", "model", "operation", "duration"];
  override side_effects = [
    "writes video file to output_path",
    "calls Runway API",
  ];
  override user_visible_verification = [
    "Watch generated clip for visual quality and motion coherence",
  ];

  private getApiKey(): string | undefined {
    return process.env.RUNWAY_API_KEY ?? process.env.RUNWAYML_API_SECRET;
  }

  override estimateCost(inputs: Record<string, unknown>): number {
    const model = (inputs.model as string) ?? "gen4_turbo";
    const duration = (inputs.duration as number) ?? 5;
    return (COST_PER_SECOND[model] ?? 0.05) * duration;
  }

  override estimateRuntime(inputs: Record<string, unknown>): number {
    const model = (inputs.model as string) ?? "gen4_turbo";
    return RUNTIME_SECONDS[model] ?? 30.0;
  }

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      return toolResult({
        success: false,
        error: "RUNWAY_API_KEY not set. " + this.install_instructions,
      });
    }

    const start = Date.now();
    const model = (inputs.model as string) ?? "gen4_turbo";
    const operation = (inputs.operation as string) ?? "text_to_video";
    const ratioFriendly = (inputs.ratio as string) ?? "16:9";
    const ratioPixels = RATIO_MAP[ratioFriendly] ?? "1280:720";

    const taskPayload: Record<string, unknown> = {
      model,
      promptText: inputs.prompt,
      duration: (inputs.duration as number) ?? 5,
      ratio: ratioPixels,
      watermark: (inputs.watermark as boolean) ?? false,
    };
    if (operation === "image_to_video" && inputs.image_url) {
      taskPayload.promptImage = inputs.image_url;
    }

    // Choose endpoint based on operation
    const endpoint =
      operation === "image_to_video"
        ? "https://api.dev.runwayml.com/v1/image_to_video"
        : "https://api.dev.runwayml.com/v1/text_to_video";

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Runway-Version": "2024-11-06",
    };

    let taskId: string;
    let outputPath: string;

    try {
      // Submit generation task
      const submitResponse = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(taskPayload),
        signal: AbortSignal.timeout(30000),
      });
      if (!submitResponse.ok) {
        const body = await submitResponse.text().catch(() => "");
        throw new Error(`HTTP ${submitResponse.status} ${submitResponse.statusText}: ${body}`);
      }
      taskId = ((await submitResponse.json()) as { id: string }).id;

      // Poll for completion (max ~5 minutes)
      let videoUrl: string | null = null;
      for (let i = 0; i < 60; i++) {
        await sleep(5000);
        const pollResponse = await fetch(
          `https://api.dev.runwayml.com/v1/tasks/${taskId}`,
          { method: "GET", headers, signal: AbortSignal.timeout(15000) }
        );
        if (!pollResponse.ok) {
          const body = await pollResponse.text().catch(() => "");
          throw new Error(`HTTP ${pollResponse.status} ${pollResponse.statusText}: ${body}`);
        }
        const taskData = (await pollResponse.json()) as Record<string, any>;
        const status = taskData.status as string;

        if (status === "SUCCEEDED") {
          videoUrl = taskData.output[0] as string;
          break;
        }
        if (status === "FAILED") {
          const failureCode = taskData.failureCode ?? "unknown";
          return toolResult({
            success: false,
            error: `Runway generation failed (${failureCode}): ${taskData.failure ?? "unknown error"}`,
          });
        }
        // PENDING, THROTTLED, RUNNING — keep polling
      }

      if (!videoUrl) {
        return toolResult({
          success: false,
          error: "Runway generation timed out after 5 minutes.",
        });
      }

      // Download video — URLs are ephemeral (expire in 24-48h)
      const videoResponse = await fetch(videoUrl, { signal: AbortSignal.timeout(120000) });
      if (!videoResponse.ok) {
        const body = await videoResponse.text().catch(() => "");
        throw new Error(`HTTP ${videoResponse.status} ${videoResponse.statusText}: ${body}`);
      }

      outputPath = (inputs.output_path as string) ?? "runway_output.mp4";
      fs.mkdirSync(path.dirname(path.resolve(outputPath)) || ".", { recursive: true });
      fs.writeFileSync(outputPath, Buffer.from(await videoResponse.arrayBuffer()));
    } catch (e) {
      return toolResult({
        success: false,
        error: `Runway video generation failed: ${(e as Error).message ?? e}`,
      });
    }

    const probed = await probeOutput(outputPath);
    return toolResult({
      success: true,
      data: {
        provider: "runway",
        model,
        prompt: inputs.prompt,
        operation,
        ratio: ratioFriendly,
        output: outputPath,
        output_path: outputPath,
        task_id: taskId,
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
