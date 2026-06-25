/**
 * Piper local text-to-speech provider tool.
 *
 * TypeScript port of tools/audio/piper_tts.py.
 *
 * Parity notes vs. Python:
 *  - Python's get_status() accepted EITHER the `piper` binary on PATH OR the
 *    importable `piper-tts` Python package. The Python package path is dropped
 *    (no Python runtime in the TS port), so availability is driven purely by the
 *    binary via dependencies=["cmd:piper"] and the base getStatus().
 *  - The subprocess call is translated verbatim to execa: same argv, text piped
 *    on stdin, 300s timeout. Non-zero exit / missing output file produce the same
 *    failure ToolResults as Python.
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
  ToolStatus,
  ToolTier,
  toolResult,
} from "../base_tool.js";

export class PiperTTS extends BaseTool {
  override name = "piper_tts";
  override version = "0.1.0";
  override tier = ToolTier.VOICE;
  override capability = "tts";
  override provider = "piper";
  override stability = ToolStability.EXPERIMENTAL;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;
  override runtime = ToolRuntime.LOCAL;

  override dependencies = ["cmd:piper"];
  override install_instructions =
    "Install Piper TTS:\n" +
    "  pip install piper-tts\n" +
    "Or download from https://github.com/rhasspy/piper/releases\n" +
    "Then download a voice model:\n" +
    "  piper --download-dir ~/.piper/models --model en_US-lessac-medium";
  override agent_skills = ["text-to-speech"];

  override capabilities = ["text_to_speech", "offline_generation"];
  override supports = {
    voice_cloning: false,
    multilingual: false,
    offline: true,
    native_audio: true,
  };
  override best_for = [
    "offline narration fallback",
    "privacy-sensitive local-only workflows",
  ];
  override not_good_for = [
    "best-in-class expressive voice quality",
    "voice clone matching",
  ];

  override input_schema = {
    type: "object",
    required: ["text"],
    properties: {
      text: { type: "string" },
      model: {
        type: "string",
        default: "en_US-lessac-medium",
      },
      speaker_id: {
        type: "integer",
        default: 0,
      },
      length_scale: {
        type: "number",
        default: 1.0,
      },
      sentence_silence: {
        type: "number",
        default: 0.3,
      },
      output_path: { type: "string" },
    },
  };

  override resource_profile: ResourceProfile = {
    cpu_cores: 2,
    ram_mb: 512,
    vram_mb: 0,
    disk_mb: 200,
    network_required: false,
  };
  override retry_policy: RetryPolicy = {
    max_retries: 1,
    backoff_seconds: 1.0,
    retryable_errors: [],
  };
  override idempotency_key_fields = [
    "text",
    "model",
    "speaker_id",
    "length_scale",
  ];
  override side_effects = ["writes audio file to output_path"];
  override user_visible_verification = [
    "Listen to generated audio for intelligibility",
  ];

  override estimateCost(_inputs: Record<string, unknown>): number {
    return 0.0;
  }

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    if (this.getStatus() !== ToolStatus.AVAILABLE) {
      return toolResult({
        success: false,
        error: "Piper TTS not available. " + this.install_instructions,
      });
    }

    const start = Date.now();
    let result: ToolResult;
    try {
      result = await this.generate(inputs);
    } catch (exc) {
      return toolResult({
        success: false,
        error: `Local TTS generation failed: ${(exc as Error).message ?? exc}`,
      });
    }

    result.duration_seconds = Math.round((Date.now() - start) / 10) / 100;
    return result;
  }

  /** Real execa translation of the Python `subprocess.run` call. */
  private async generate(inputs: Record<string, unknown>): Promise<ToolResult> {
    const outputPath = path.resolve(
      (inputs.output_path as string) ?? "tts_output.wav"
    );
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const model = (inputs.model as string) ?? "en_US-lessac-medium";
    const speakerId = (inputs.speaker_id as number) ?? 0;
    const lengthScale = (inputs.length_scale as number) ?? 1.0;
    const sentenceSilence = (inputs.sentence_silence as number) ?? 0.3;
    const text = inputs.text as string;

    const proc = await execa(
      "piper",
      [
        "--model",
        model,
        "--speaker",
        String(speakerId),
        "--length-scale",
        String(lengthScale),
        "--sentence-silence",
        String(sentenceSilence),
        "--output_file",
        outputPath,
      ],
      { input: text, timeout: 300000, reject: false }
    );

    if (proc.exitCode !== 0) {
      return toolResult({
        success: false,
        error: `Piper failed (exit ${proc.exitCode}): ${proc.stderr}`,
      });
    }
    if (!fs.existsSync(outputPath)) {
      return toolResult({
        success: false,
        error: `Piper output file missing: ${outputPath}`,
      });
    }

    return toolResult({
      success: true,
      data: {
        provider: this.provider,
        model,
        speaker_id: speakerId,
        text_length: text.length,
        output: outputPath,
        format: "wav",
      },
      artifacts: [outputPath],
      model,
    });
  }
}
