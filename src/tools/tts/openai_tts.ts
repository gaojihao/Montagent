/**
 * OpenAI text-to-speech provider tool.
 *
 * TypeScript port of tools/audio/openai_tts.py.
 *
 * Parity notes vs. Python:
 *  - Python declared dependencies=[] and overrode get_status() to check
 *    OPENAI_API_KEY. The TS port uses dependencies=["env:OPENAI_API_KEY"] so the
 *    base getStatus() drives availability — behaviorally identical (UNAVAILABLE
 *    without the key).
 *  - Python used the `openai` SDK (client.audio.speech...). Per the canonical
 *    requests->fetch convention this is translated to a direct fetch POST to the
 *    OpenAI audio/speech endpoint. The request body (model, voice, input,
 *    response_format, optional instructions, optional speed) matches the SDK
 *    kwargs verbatim, including the `speed` field which Python reads even though
 *    it is absent from input_schema.
 *  - audio_duration_seconds is filled via ffprobe (the Python probe_duration),
 *    returning null when ffprobe is unavailable.
 */
import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
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

/** Quick ffprobe duration helper (port of tools.analysis.audio_probe.probe_duration). */
async function probeDuration(filePath: string): Promise<number | null> {
  try {
    const { stdout, exitCode } = await execa(
      "ffprobe",
      ["-v", "quiet", "-print_format", "json", "-show_format", filePath],
      { timeout: 10000, reject: false }
    );
    if (exitCode !== 0) return null;
    const data = JSON.parse(stdout) as { format?: { duration?: string } };
    const dur = data.format?.duration;
    return dur != null ? parseFloat(dur) : null;
  } catch {
    return null;
  }
}

export class OpenAITTS extends BaseTool {
  override name = "openai_tts";
  override version = "0.1.0";
  override tier = ToolTier.VOICE;
  override capability = "tts";
  override provider = "openai";
  override stability = ToolStability.EXPERIMENTAL;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.STOCHASTIC;
  override runtime = ToolRuntime.API;

  override dependencies = ["env:OPENAI_API_KEY"];
  override install_instructions =
    "Set the OPENAI_API_KEY environment variable:\n" +
    "  export OPENAI_API_KEY=your_key_here\n" +
    "Get a key at https://platform.openai.com/";
  override fallback = "piper_tts";
  override fallback_tools = ["piper_tts"];
  override agent_skills = ["openai-docs"];

  override capabilities = ["text_to_speech", "voice_selection"];
  override supports = {
    voice_cloning: false,
    multilingual: true,
    offline: false,
    native_audio: true,
  };
  override best_for = [
    "general narration fallback",
    "API-based production when ElevenLabs is unavailable",
  ];
  override not_good_for = ["voice clone matching", "fully offline production"];

  override input_schema = {
    type: "object",
    required: ["text"],
    properties: {
      text: { type: "string" },
      voice: {
        type: "string",
        default: "alloy",
        description: "OpenAI voice name",
      },
      model: {
        type: "string",
        default: "gpt-4o-mini-tts",
        description: "OpenAI speech model",
      },
      format: {
        type: "string",
        default: "mp3",
        enum: ["mp3", "wav", "pcm"],
      },
      instructions: {
        type: "string",
        description: "Optional delivery instructions for the voice",
      },
      output_path: { type: "string" },
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
  override idempotency_key_fields = ["text", "voice", "model", "format"];
  override side_effects = [
    "writes audio file to output_path",
    "calls OpenAI API",
  ];
  override user_visible_verification = [
    "Listen to generated audio for intelligibility and tone",
  ];

  override estimateCost(inputs: Record<string, unknown>): number {
    const text = (inputs.text as string) ?? "";
    return Math.round(text.length * 0.000015 * 10000) / 10000;
  }

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    if (!process.env.OPENAI_API_KEY) {
      return toolResult({
        success: false,
        error: "No OpenAI API key. " + this.install_instructions,
      });
    }

    const start = Date.now();
    let result: ToolResult;
    try {
      result = await this.generate(inputs);
    } catch (exc) {
      return toolResult({
        success: false,
        error: `OpenAI TTS failed: ${(exc as Error).message ?? exc}`,
      });
    }

    result.duration_seconds = Math.round((Date.now() - start) / 10) / 100;
    result.cost_usd = this.estimateCost(inputs);
    return result;
  }

  /** Real fetch translation of the Python `openai` SDK speech call. */
  private async generate(inputs: Record<string, unknown>): Promise<ToolResult> {
    const text = inputs.text as string;
    const model = (inputs.model as string) ?? "gpt-4o-mini-tts";
    const voice = (inputs.voice as string) ?? "alloy";
    const fmt = (inputs.format as string) ?? "mp3";
    const outputPath = path.resolve(
      (inputs.output_path as string) ?? `openai_tts.${fmt}`
    );
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const body: Record<string, unknown> = {
      model,
      voice,
      input: text,
      response_format: fmt,
    };
    if (inputs.instructions) body.instructions = inputs.instructions;
    if (inputs.speed && inputs.speed !== 1.0) body.speed = inputs.speed;

    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      throw new Error(
        `HTTP ${response.status} ${response.statusText}: ${errBody}`
      );
    }

    fs.writeFileSync(outputPath, Buffer.from(await response.arrayBuffer()));

    const audioDuration = await probeDuration(outputPath);

    return toolResult({
      success: true,
      data: {
        provider: this.provider,
        model,
        voice,
        format: fmt,
        text_length: text.length,
        audio_duration_seconds:
          audioDuration != null ? Math.round(audioDuration * 100) / 100 : null,
        output: outputPath,
      },
      artifacts: [outputPath],
      model,
    });
  }
}
