/**
 * Capability-level video-generation selector (TS port of tools/video/video_selector.py).
 * Auto-discovers any tool with capability="video_generation" and routes via lib/scoring.
 */
import { BaseSelector } from "../selector_base.js";
import { ToolTier } from "../base_tool.js";

export class VideoSelector extends BaseSelector {
  override name = "video_selector";
  override version = "0.2.0";
  override tier = ToolTier.GENERATE;
  override capability = "video_generation";
  override agent_skills = ["ai-video-gen", "seedance-2-0", "ltx2"];
  protected override promptField = "prompt";

  override capabilities = ["generate_video", "provider_selection"];
  override supports = {
    user_preference_routing: true,
    stock_fallback: true,
    image_to_video: true,
    text_to_video: true,
  };
  override best_for = ["preflight tool selection", "user-facing recommendation flows"];

  override input_schema = {
    type: "object",
    required: ["prompt"],
    properties: {
      prompt: { type: "string" },
      operation: {
        type: "string",
        enum: ["text_to_video", "image_to_video", "rank"],
        default: "text_to_video",
      },
      reference_image_url: { type: "string" },
      reference_image_path: { type: "string" },
      aspect_ratio: { type: "string" },
      duration_hint: { type: "string" },
      width: { type: "integer" },
      height: { type: "integer" },
      num_frames: { type: "integer" },
      seed: { type: "integer" },
      preferred_provider: { type: "string", default: "auto" },
      allowed_providers: { type: "array", items: { type: "string" } },
      output_path: { type: "string" },
    },
  };

  // video uses "operation" for text/image-to-video too; only "rank" is the ranking mode.
  protected override prepareTaskContext(inputs: Record<string, unknown>): Record<string, unknown> {
    return super.prepareTaskContext({
      ...inputs,
      operation: inputs.operation === "rank" ? "rank" : "generate",
    });
  }
}
