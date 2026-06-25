/**
 * Capability-level screen-capture selector (TS port of tools/capture/screen_capture_selector.py).
 * Auto-discovers any tool with capability="screen_capture" (screen_recorder, cap_recorder)
 * and routes via lib/scoring (Cap scores higher for webcam/cursor polish; ffmpeg for quick/headless).
 */
import { BaseSelector } from "../selector_base.js";
import { ToolTier } from "../base_tool.js";

export class ScreenCaptureSelector extends BaseSelector {
  override name = "screen_capture_selector";
  override version = "0.2.0";
  override tier = ToolTier.SOURCE;
  override capability = "screen_capture";
  override agent_skills = ["playwright-recording"];
  protected override promptField = "intent"; // screen capture has no prompt; use optional 'intent'

  override capabilities = ["screen_capture", "provider_selection"];
  override supports = { user_preference_routing: true, ffmpeg_fallback: true, cap_integration: true };
  override best_for = ["preflight tool selection", "choosing between Cap and FFmpeg capture"];

  override input_schema = {
    type: "object",
    properties: {
      operation: { type: "string", description: "Passed through to the chosen provider (e.g. record/detect), or 'rank'." },
      intent: { type: "string", description: "Optional natural-language hint for scoring (e.g. 'webcam overlay tutorial')." },
      output_path: { type: "string" },
      duration_seconds: { type: "integer" },
      fps: { type: "integer" },
      capture_audio: { type: "boolean" },
      preferred_provider: { type: "string", default: "auto" },
      allowed_providers: { type: "array", items: { type: "string" } },
    },
  };
}
