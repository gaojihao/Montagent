/**
 * ElevenLabs text-to-speech provider tool.
 *
 * TypeScript port of tools/audio/elevenlabs_tts.py. This is the canonical
 * HTTP-tool pattern proof: execute() is a real `fetch`-based translation of the
 * Python `requests` call (proving the requests -> fetch migration), and the
 * tool reports UNAVAILABLE via its env dependency when no API key is present
 * (it never calls the API in that case).
 *
 * Parity notes vs. Python:
 *  - Python declared dependencies=[] and overrode get_status() to check the
 *    env var directly. The TS port uses dependencies=["env:ELEVENLABS_API_KEY"]
 *    so the base getStatus() drives availability — behaviorally identical
 *    (UNAVAILABLE without the key) and keeps the elevenlabs entry in setup_offers.
 *  - Endpoint, headers, JSON body, voice_settings, output_format query param,
 *    default voice id, and cost estimate all match the Python verbatim.
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

export class ElevenLabsTTS extends BaseTool {
  override name = "elevenlabs_tts";
  override version = "0.1.0";
  override tier = ToolTier.VOICE;
  override capability = "tts";
  override provider = "elevenlabs";
  override stability = ToolStability.EXPERIMENTAL;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.STOCHASTIC;
  override runtime = ToolRuntime.API;

  override dependencies = ["env:ELEVENLABS_API_KEY"];
  override install_instructions =
    "Set the ELEVENLABS_API_KEY environment variable:\n" +
    "  export ELEVENLABS_API_KEY=your_key_here\n" +
    "Get a key at https://elevenlabs.io";
  override fallback = "openai_tts";
  override fallback_tools = ["openai_tts", "piper_tts"];
  override agent_skills = ["elevenlabs", "text-to-speech"];

  override capabilities = [
    "text_to_speech",
    "voice_selection",
    "ssml_support",
    "pronunciation_control",
  ];
  override supports = {
    voice_cloning: true,
    multilingual: true,
    offline: false,
    native_audio: true,
  };
  override best_for = [
    "high-quality narration",
    "voice-sensitive spokesperson videos",
    "multilingual spoken delivery",
  ];
  override not_good_for = [
    "fully offline production",
    "privacy-constrained local-only workflows",
  ];

  override input_schema = {
    type: "object",
    required: ["text"],
    properties: {
      text: { type: "string", description: "Text to convert to speech" },
      voice_id: {
        type: "string",
        description: "ElevenLabs voice ID (default: Rachel)",
      },
      model_id: {
        type: "string",
        default: "eleven_multilingual_v2",
        description: "TTS model to use",
      },
      stability: { type: "number", default: 0.5, minimum: 0, maximum: 1 },
      similarity_boost: {
        type: "number",
        default: 0.75,
        minimum: 0,
        maximum: 1,
      },
      style: { type: "number", default: 0.0, minimum: 0, maximum: 1 },
      output_path: { type: "string" },
      output_format: {
        type: "string",
        default: "mp3_44100_128",
        enum: ["mp3_44100_128", "mp3_44100_192", "pcm_16000", "pcm_24000"],
      },
    },
  };

  override resource_profile: ResourceProfile = {
    cpu_cores: 1,
    ram_mb: 256,
    vram_mb: 0,
    disk_mb: 50,
    network_required: true,
  };
  override retry_policy: RetryPolicy = {
    max_retries: 2,
    backoff_seconds: 1.0,
    retryable_errors: ["rate_limit", "timeout"],
  };
  override idempotency_key_fields = ["text", "voice_id", "model_id"];
  override side_effects = [
    "writes audio file to output_path",
    "calls ElevenLabs API",
  ];
  override user_visible_verification = [
    "Listen to generated audio for natural speech quality",
  ];

  static readonly DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

  override estimateCost(inputs: Record<string, unknown>): number {
    const text = (inputs.text as string) ?? "";
    return Math.round(text.length * 0.0003 * 10000) / 10000;
  }

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      return toolResult({
        success: false,
        error: "No ElevenLabs API key. " + this.install_instructions,
      });
    }

    const start = Date.now();
    let result: ToolResult;
    try {
      result = await this.generate(inputs, apiKey);
    } catch (exc) {
      return toolResult({
        success: false,
        error: `TTS generation failed: ${(exc as Error).message ?? exc}`,
      });
    }

    result.duration_seconds = Math.round((Date.now() - start) / 10) / 100;
    result.cost_usd = this.estimateCost(inputs);
    return result;
  }

  /** Real fetch translation of the Python `requests.post` call. */
  private async generate(
    inputs: Record<string, unknown>,
    apiKey: string
  ): Promise<ToolResult> {
    const text = inputs.text as string;
    const voiceId =
      (inputs.voice_id as string) ?? ElevenLabsTTS.DEFAULT_VOICE_ID;
    const modelId = (inputs.model_id as string) ?? "eleven_multilingual_v2";
    const outputFormat =
      (inputs.output_format as string) ?? "mp3_44100_128";

    const url = new URL(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`
    );
    url.searchParams.set("output_format", outputFormat);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: {
          stability: (inputs.stability as number) ?? 0.5,
          similarity_boost: (inputs.similarity_boost as number) ?? 0.75,
          style: (inputs.style as number) ?? 0.0,
        },
      }),
    });

    if (!response.ok) {
      // Mirror requests.raise_for_status(): surface status + body.
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${body}`);
    }

    const ext = outputFormat.includes("mp3") ? "mp3" : "wav";
    const outputPath = path.resolve(
      (inputs.output_path as string) ?? `tts_output.${ext}`
    );
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const buf = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(outputPath, buf);

    return toolResult({
      success: true,
      data: {
        provider: this.provider,
        model: modelId,
        voice_id: voiceId,
        text_length: text.length,
        output: outputPath,
        format: outputFormat,
      },
      artifacts: [outputPath],
      model: modelId,
    });
  }
}
