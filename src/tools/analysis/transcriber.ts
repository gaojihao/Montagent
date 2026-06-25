/**
 * Transcription tool (TS port of tools/analysis/transcriber.py).
 *
 * Python used faster-whisper / WhisperX (CTranslate2 + optional torch). Per the
 * no-PyTorch rule, the TS port uses @xenova/transformers (Transformers.js, ONNX/CPU,
 * free, no GPU): ffmpeg decodes the input to 16kHz mono f32 PCM, then the whisper
 * ASR pipeline produces WORD-LEVEL timestamps (subtitle + TTS-misread detection
 * depend on these). Output JSON shape matches the Python: segments[] + word_timestamps[].
 *
 * Diarization (WhisperX/pyannote) is dropped (torch-only); diarize requests degrade
 * gracefully to non-diarized output, mirroring Python without whisperx installed.
 */
import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import {
  BaseTool,
  commandExists,
  Determinism,
  ExecutionMode,
  type ResourceProfile,
  type RetryPolicy,
  ResumeSupport,
  type ToolResult,
  ToolStability,
  ToolStatus,
  ToolTier,
  toolResult,
} from "../base_tool.js";

// Cache one ASR pipeline per model so repeated calls don't re-load the model.
const PIPELINE_CACHE = new Map<string, Promise<unknown>>();

const MODEL_MAP: Record<string, string> = {
  tiny: "Xenova/whisper-tiny",
  base: "Xenova/whisper-base",
  small: "Xenova/whisper-small",
  medium: "Xenova/whisper-medium",
  "large-v2": "Xenova/whisper-large-v2",
  "large-v3": "Xenova/whisper-large-v3",
};

export class Transcriber extends BaseTool {
  override name = "transcriber";
  override version = "0.1.0";
  override tier = ToolTier.CORE;
  override capability = "analysis";
  override provider = "whisperx";
  override stability = ToolStability.EXPERIMENTAL;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;

  override dependencies = ["cmd:ffmpeg"]; // transformers.js is bundled; ffmpeg decodes audio
  override install_instructions =
    "Requires ffmpeg for audio decoding. Speech recognition runs on CPU via Transformers.js " +
    "(@xenova/transformers); the whisper model downloads automatically on first use.";
  override agent_skills = ["speech-to-text"];

  override capabilities = ["transcribe", "word_timestamps", "diarization", "language_detection"];

  override input_schema = {
    type: "object",
    required: ["input_path"],
    properties: {
      input_path: { type: "string", description: "Path to audio or video file" },
      model_size: {
        type: "string",
        enum: ["tiny", "base", "small", "medium", "large-v2", "large-v3"],
        default: "base",
      },
      language: { type: "string", description: "ISO 639-1 language code, or null for auto-detect" },
      diarize: { type: "boolean", default: false },
      output_dir: { type: "string", description: "Directory for output files" },
    },
  };

  override resource_profile: ResourceProfile = {
    cpu_cores: 2,
    ram_mb: 2048,
    vram_mb: 0,
    disk_mb: 500,
    network_required: false,
  };
  override retry_policy: RetryPolicy = { max_retries: 1, backoff_seconds: 1.0, retryable_errors: ["MemoryError"] };
  override resume_support = ResumeSupport.FROM_START;
  override idempotency_key_fields = ["input_path", "model_size", "language"];
  override side_effects = ["writes transcript JSON to output_dir"];
  override fallback = null;
  override user_visible_verification = [
    "Check transcript text against source audio",
    "Verify word timestamps align with speech",
  ];

  override getStatus(): ToolStatus {
    // CPU transcription needs ffmpeg to decode audio; the model is fetched lazily.
    return commandExists("ffmpeg") ? ToolStatus.AVAILABLE : ToolStatus.UNAVAILABLE;
  }

  override estimateRuntime(_inputs: Record<string, unknown>): number {
    return 60.0;
  }

  private async getPipeline(model: string): Promise<(audio: Float32Array, opts: Record<string, unknown>) => Promise<unknown>> {
    if (!PIPELINE_CACHE.has(model)) {
      const specifier = "@xenova/transformers";
      const pipe = import(specifier).then(async (m: any) =>
        m.pipeline("automatic-speech-recognition", model)
      );
      PIPELINE_CACHE.set(model, pipe);
    }
    return PIPELINE_CACHE.get(model) as Promise<(audio: Float32Array, opts: Record<string, unknown>) => Promise<unknown>>;
  }

  /** Decode any audio/video file to a 16kHz mono Float32Array via ffmpeg. */
  private async decodeAudio(inputPath: string): Promise<Float32Array> {
    const { stdout } = await execa(
      "ffmpeg",
      ["-i", inputPath, "-ar", "16000", "-ac", "1", "-f", "f32le", "-"],
      { encoding: "buffer", maxBuffer: 1024 * 1024 * 1024, reject: true }
    );
    const buf = stdout as unknown as Buffer;
    return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
  }

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const inputPath = inputs.input_path as string;
    const modelSize = (inputs.model_size as string) ?? "base";
    const language = (inputs.language as string) ?? undefined;
    const outputDir = (inputs.output_dir as string) ?? path.dirname(inputPath);

    if (!fs.existsSync(inputPath)) {
      return toolResult({ success: false, error: `Input file not found: ${inputPath}` });
    }
    if (!commandExists("ffmpeg")) {
      return toolResult({ success: false, error: "ffmpeg is required to decode audio for transcription." });
    }
    fs.mkdirSync(outputDir, { recursive: true });

    const start = Date.now();
    let audio: Float32Array;
    try {
      audio = await this.decodeAudio(inputPath);
    } catch (e) {
      return toolResult({ success: false, error: `Audio decode failed: ${(e as Error).message}` });
    }

    let asrResult: { text?: string; chunks?: Array<{ text: string; timestamp: [number, number | null] }> };
    try {
      const model = MODEL_MAP[modelSize] ?? MODEL_MAP.base!;
      const asr = await this.getPipeline(model);
      asrResult = (await asr(audio, {
        return_timestamps: "word",
        chunk_length_s: 30,
        stride_length_s: 5,
        ...(language ? { language } : {}),
      })) as typeof asrResult;
    } catch (e) {
      return toolResult({
        success: false,
        error: `Transcription failed (Transformers.js): ${(e as Error).message}`,
      });
    }

    // Build word_timestamps[] from the word chunks and group them into segments
    // by sentence-ending punctuation (approximating whisper's segment split).
    const wordTimestamps: Array<{ word: string; start: number; end: number; probability: number }> = [];
    const segments: Array<Record<string, unknown>> = [];
    let segWords: typeof wordTimestamps = [];
    let segId = 0;
    const round3 = (n: number) => Math.round(n * 1000) / 1000;

    const flushSegment = () => {
      if (segWords.length === 0) return;
      segments.push({
        id: segId++,
        start: segWords[0]!.start,
        end: segWords[segWords.length - 1]!.end,
        text: segWords.map((w) => w.word).join("").trim(),
        words: segWords,
      });
      segWords = [];
    };

    for (const chunk of asrResult.chunks ?? []) {
      const [s, e] = chunk.timestamp;
      const entry = {
        word: chunk.text,
        start: round3(s ?? 0),
        end: round3(e ?? s ?? 0),
        probability: 1.0, // Transformers.js does not expose per-word probability
      };
      wordTimestamps.push(entry);
      segWords.push(entry);
      if (/[.!?]\s*$/.test(chunk.text)) flushSegment();
    }
    flushSegment();

    const duration = audio.length / 16000;
    const resultData = {
      segments,
      word_timestamps: wordTimestamps,
      language: language ?? "auto",
      duration_seconds: round3(duration),
      model_size: modelSize,
      device: "cpu",
    };

    const outputPath = path.join(outputDir, `${path.basename(inputPath, path.extname(inputPath))}_transcript.json`);
    fs.writeFileSync(outputPath, JSON.stringify(resultData, null, 2), "utf-8");

    return toolResult({
      success: true,
      data: resultData,
      artifacts: [outputPath],
      duration_seconds: Math.round((Date.now() - start) / 10) / 100,
    });
  }
}
