/**
 * Capability-level image-generation selector (TS port of tools/graphics/image_selector.py).
 * Auto-discovers any tool with capability="image_generation" and routes via lib/scoring.
 */
import { BaseSelector } from "../selector_base.js";
import { ToolTier } from "../base_tool.js";

export class ImageSelector extends BaseSelector {
  override name = "image_selector";
  override version = "0.2.0";
  override tier = ToolTier.GENERATE;
  override capability = "image_generation";
  override agent_skills = ["flux-best-practices", "bfl-api"];
  protected override promptField = "prompt";

  override capabilities = ["generate_image", "provider_selection"];
  override supports = { user_preference_routing: true, stock_fallback: true, reference_image: true };
  override best_for = ["preflight tool selection", "user-facing recommendation flows"];

  override input_schema = {
    type: "object",
    required: ["prompt"],
    properties: {
      prompt: { type: "string" },
      negative_prompt: { type: "string" },
      width: { type: "integer" },
      height: { type: "integer" },
      aspect_ratio: { type: "string" },
      seed: { type: "integer" },
      model: { type: "string" },
      preferred_provider: { type: "string", default: "auto" },
      allowed_providers: { type: "array", items: { type: "string" } },
      operation: { type: "string", enum: ["generate", "rank"], default: "generate" },
      output_path: { type: "string" },
    },
  };
}
