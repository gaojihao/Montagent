/**
 * Modal-hosted LTX video generation.
 *
 * TypeScript port of tools/video/ltx_video_modal.py. execute() delegates to the
 * already-ported generateLtxModalVideo helper in ./_shared.js (matching the
 * Python tool which delegates to generate_ltx_modal_video). Note this is a
 * self-hosted *cloud* (Modal) endpoint, NOT local GPU.
 *
 * Parity notes vs. Python:
 *  - Python declared no dependencies and overrode get_status() to check
 *    MODAL_LTX2_ENDPOINT_URL. The TS port uses
 *    dependencies=["env:MODAL_LTX2_ENDPOINT_URL"] so the base getStatus() drives
 *    availability — behaviorally identical and keeps the entry in setup_offers.
 *  - name/capability/provider/runtime/tier/stability, install copy, provider_matrix,
 *    schema, fixed cost/runtime estimates, and the delegate call all match verbatim.
 */
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
import { generateLtxModalVideo } from "./_shared.js";

export class LTXVideoModal extends BaseTool {
  override name = "ltx_video_modal";
  override version = "0.1.0";
  override tier = ToolTier.GENERATE;
  override capability = "video_generation";
  override provider = "ltx-modal";
  override stability = ToolStability.EXPERIMENTAL;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.STOCHASTIC;
  override runtime = ToolRuntime.API;

  override dependencies = ["env:MODAL_LTX2_ENDPOINT_URL"];
  override install_instructions =
    "Set the MODAL_LTX2_ENDPOINT_URL environment variable to your deployed LTX endpoint:\n" +
    "  set MODAL_LTX2_ENDPOINT_URL=https://<your-modal-endpoint>";
  override fallback = "ltx_video_local";
  override fallback_tools = [
    "ltx_video_local",
    "wan_video",
    "hunyuan_video",
    "cogvideo_video",
    "image_selector",
  ];
  override agent_skills = ["ltx2"];

  override capabilities = ["text_to_video", "image_to_video"];
  override supports = {
    reference_image: true,
    offline: false,
    native_audio: false,
    self_hosted_cloud: true,
  };
  override best_for = [
    "self-hosted cloud GPU rendering for LTX without local workstation dependence",
  ];
  override not_good_for = ["zero-setup local workflows"];
  override provider_matrix = {
    "ltx2-modal": {
      tool: "ltx_video_modal",
      name: "LTX-2 (Modal)",
      mode: "api",
      quality: "high",
      speed: "medium",
    },
  };

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
      reference_image_url: { type: "string" },
      reference_image_path: { type: "string" },
      aspect_ratio: {
        type: "string",
        enum: ["16:9", "9:16", "1:1"],
        default: "16:9",
      },
      duration_hint: { type: "string" },
      width: { type: "integer" },
      height: { type: "integer" },
      num_frames: { type: "integer" },
      num_inference_steps: { type: "integer" },
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
    backoff_seconds: 10.0,
    retryable_errors: ["timeout", "server_error"],
  };
  override idempotency_key_fields = [
    "prompt",
    "aspect_ratio",
    "num_frames",
    "seed",
  ];
  override side_effects = [
    "writes video file to output_path",
    "calls modal endpoint",
  ];
  override user_visible_verification = [
    "Watch generated clip for motion quality and prompt adherence",
  ];

  override estimateCost(_inputs: Record<string, unknown>): number {
    return 0.25;
  }

  override estimateRuntime(_inputs: Record<string, unknown>): number {
    return 180.0;
  }

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    if (this.getStatus() !== ToolStatus.AVAILABLE) {
      return toolResult({
        success: false,
        error:
          "Modal LTX video generation is unavailable. " +
          this.install_instructions,
      });
    }
    const start = Date.now();
    let result: ToolResult;
    try {
      result = await generateLtxModalVideo(inputs);
    } catch (exc) {
      return toolResult({
        success: false,
        error: `Modal LTX video generation failed: ${(exc as Error).message ?? exc}`,
      });
    }
    result.duration_seconds = Math.round((Date.now() - start) / 10) / 100;
    result.cost_usd = this.estimateCost(inputs);
    return result;
  }
}
