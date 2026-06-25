/**
 * Capability-level TTS selector (TS port of tools/audio/tts_selector.py).
 * Auto-discovers any tool with capability="tts" and routes via lib/scoring.
 */
import { BaseSelector } from "../selector_base.js";
import { ToolTier } from "../base_tool.js";

export class TTSSelector extends BaseSelector {
  override name = "tts_selector";
  override version = "0.2.0";
  override tier = ToolTier.VOICE;
  override capability = "tts";
  override agent_skills = ["text-to-speech", "elevenlabs", "openai-docs"];
  protected override promptField = "text";

  override capabilities = ["text_to_speech", "provider_selection"];
  override supports = { user_preference_routing: true, offline_fallback: true, multilingual: true };
  override best_for = ["preflight tool selection", "user-facing recommendation flows"];

  override input_schema = {
    type: "object",
    required: ["text"],
    properties: {
      text: { type: "string" },
      voice_id: { type: "string", description: "Provider-specific voice ID; passed through." },
      model_id: { type: "string", description: "TTS model; passed through." },
      stability: { type: "number", minimum: 0, maximum: 1 },
      similarity_boost: { type: "number", minimum: 0, maximum: 1 },
      style: { type: "number", minimum: 0, maximum: 1 },
      output_format: { type: "string" },
      preferred_provider: { type: "string", default: "auto" },
      allowed_providers: { type: "array", items: { type: "string" } },
      operation: { type: "string", enum: ["generate", "rank"], default: "generate" },
      output_path: { type: "string" },
    },
  };
}
