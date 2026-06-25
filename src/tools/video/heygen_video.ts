/**
 * HeyGen-backed cloud video generation.
 *
 * TypeScript port of tools/video/heygen_video.py. execute() delegates to the
 * already-ported generateHeygenVideo helper in ./_shared.js (matching the
 * Python tool which delegates to generate_heygen_video).
 *
 * Parity notes vs. Python:
 *  - Python declared no dependencies and overrode get_status() to check
 *    HEYGEN_API_KEY. The TS port uses dependencies=["env:HEYGEN_API_KEY"] so
 *    the base getStatus() drives availability — behaviorally identical
 *    (UNAVAILABLE without the key) and keeps the heygen entry in setup_offers.
 *  - name/capability/provider/runtime/tier/stability, install copy, provider_matrix,
 *    schema, cost/runtime estimates, and the delegate call all match verbatim.
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
import {
  HEYGEN_PROVIDERS,
  estimateQualityCost,
  estimateSpeedRuntime,
  generateHeygenVideo,
} from "./_shared.js";

export class HeyGenVideo extends BaseTool {
  override name = "heygen_video";
  override version = "0.1.0";
  override tier = ToolTier.GENERATE;
  override capability = "video_generation";
  override provider = "heygen";
  override stability = ToolStability.EXPERIMENTAL;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.STOCHASTIC;
  override runtime = ToolRuntime.API;

  override dependencies = ["env:HEYGEN_API_KEY"];
  override install_instructions =
    "Set the HEYGEN_API_KEY environment variable:\n" +
    "  set HEYGEN_API_KEY=your_key_here\n" +
    "Get a key at https://app.heygen.com/settings/api";
  override fallback = "wan_video";
  override fallback_tools = [
    "wan_video",
    "hunyuan_video",
    "ltx_video_local",
    "cogvideo_video",
    "ltx_video_modal",
    "image_selector",
  ];
  override agent_skills = ["ai-video-gen", "create-video"];

  override capabilities = [
    "text_to_video",
    "image_to_video",
    "provider_selection",
  ];
  override supports = {
    reference_image: true,
    offline: false,
    native_audio: false,
    cloud_generation: true,
  };
  override best_for = [
    "premium cloud video generation without local GPU setup",
    "fast access to VEO, Sora, Kling, Runway, and Seedance providers",
  ];
  override not_good_for = [
    "offline or privacy-constrained rendering",
    "free local-first production",
  ];
  override provider_matrix = Object.fromEntries(
    Object.entries(HEYGEN_PROVIDERS).map(([key, value]) => [
      key,
      { tool: "heygen_video", ...value, mode: "api" },
    ])
  );

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
      provider_variant: {
        type: "string",
        enum: Object.keys(HEYGEN_PROVIDERS).sort(),
        default: "veo_3_1",
      },
      reference_image_url: { type: "string" },
      reference_image_path: { type: "string" },
      aspect_ratio: {
        type: "string",
        enum: ["16:9", "9:16", "1:1"],
        default: "16:9",
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
    backoff_seconds: 10.0,
    retryable_errors: ["rate_limit", "timeout", "server_error"],
  };
  override idempotency_key_fields = [
    "prompt",
    "provider_variant",
    "aspect_ratio",
  ];
  override side_effects = [
    "writes video file to output_path",
    "calls HeyGen API",
  ];
  override user_visible_verification = [
    "Watch generated clip for motion quality and prompt adherence",
  ];

  override estimateCost(inputs: Record<string, unknown>): number {
    const variant = (inputs.provider_variant as string) ?? "veo_3_1";
    const meta = HEYGEN_PROVIDERS[variant] ?? HEYGEN_PROVIDERS.veo_3_1!;
    return estimateQualityCost(meta.quality);
  }

  override estimateRuntime(inputs: Record<string, unknown>): number {
    const variant = (inputs.provider_variant as string) ?? "veo_3_1";
    const meta = HEYGEN_PROVIDERS[variant] ?? HEYGEN_PROVIDERS.veo_3_1!;
    return estimateSpeedRuntime(meta.speed);
  }

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    if (this.getStatus() !== ToolStatus.AVAILABLE) {
      return toolResult({
        success: false,
        error:
          "HeyGen video generation is unavailable. " + this.install_instructions,
      });
    }
    const start = Date.now();
    let result: ToolResult;
    try {
      result = await generateHeygenVideo(inputs);
    } catch (exc) {
      return toolResult({
        success: false,
        error: `HeyGen video generation failed: ${(exc as Error).message ?? exc}`,
      });
    }
    result.duration_seconds = Math.round((Date.now() - start) / 10) / 100;
    result.cost_usd = this.estimateCost(inputs);
    return result;
  }
}
