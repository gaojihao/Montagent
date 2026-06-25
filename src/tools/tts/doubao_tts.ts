/**
 * Doubao Speech text-to-speech provider tool.
 *
 * TypeScript port of tools/audio/doubao_tts.py.
 *
 * Parity notes vs. Python:
 *  - Python declared dependencies=[] and overrode get_status() to check
 *    DOUBAO_SPEECH_API_KEY. The TS port uses
 *    dependencies=["env:DOUBAO_SPEECH_API_KEY"] so the base getStatus() drives
 *    availability — behaviorally identical (UNAVAILABLE without the key).
 *  - The async submit -> poll -> download flow, headers, body, Doubao error-code
 *    handling, diagnostic hints, secret redaction, and cost-from-usage logic all
 *    match the Python verbatim (requests -> fetch).
 *  - audio_duration_seconds is filled via ffprobe (the Python probe_duration),
 *    returning null when ffprobe is unavailable.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

export class DoubaoTTS extends BaseTool {
  override name = "doubao_tts";
  override version = "0.1.0";
  override tier = ToolTier.VOICE;
  override capability = "tts";
  override provider = "doubao";
  override stability = ToolStability.EXPERIMENTAL;
  override execution_mode = ExecutionMode.ASYNC;
  override determinism = Determinism.STOCHASTIC;
  override runtime = ToolRuntime.API;

  override dependencies = ["env:DOUBAO_SPEECH_API_KEY"];
  override install_instructions =
    "Set DOUBAO_SPEECH_API_KEY to a Volcengine Doubao Speech API Key.\n" +
    "Optional: set DOUBAO_SPEECH_VOICE_TYPE to the default speaker voice.\n" +
    "Use the new console API key flow; do not pass app id/access token as the API key.";
  override fallback = "google_tts";
  override fallback_tools = [
    "google_tts",
    "elevenlabs_tts",
    "openai_tts",
    "piper_tts",
  ];
  override agent_skills = ["doubao-tts", "text-to-speech"];

  override capabilities = [
    "text_to_speech",
    "voice_selection",
    "multilingual",
    "timestamp_alignment",
  ];
  override supports = {
    voice_cloning: false,
    multilingual: true,
    offline: false,
    native_audio: true,
    timestamps: true,
    long_text_async: true,
  };
  override best_for = [
    "natural Mandarin narration",
    "Chinese explainer voiceovers with character-level timestamps",
    "long-form narration that needs subtitle alignment",
  ];
  override not_good_for = [
    "fully offline production",
    "voice clone matching",
    "real-time interactive speech playback",
  ];

  override input_schema = {
    type: "object",
    required: ["text"],
    properties: {
      text: { type: "string", description: "Text to convert to speech" },
      voice_id: {
        type: "string",
        description:
          "Doubao speaker/voice_type. Defaults to DOUBAO_SPEECH_VOICE_TYPE.",
      },
      resource_id: {
        type: "string",
        default: "seed-tts-2.0",
        description:
          "Volcengine resource id. Use seed-tts-2.0 for Doubao Speech 2.0 voices.",
      },
      format: {
        type: "string",
        default: "mp3",
        enum: ["mp3", "ogg_opus", "pcm"],
      },
      sample_rate: {
        type: "integer",
        default: 24000,
        enum: [8000, 16000, 22050, 24000, 32000, 44100, 48000],
      },
      speech_rate: {
        type: "integer",
        default: 0,
        minimum: -50,
        maximum: 100,
        description: "Doubao speech rate. 0=normal, 100=2x, -50=0.5x.",
      },
      enable_timestamp: {
        type: "boolean",
        default: true,
        description:
          "Return sentence/word timing metadata when supported by the selected endpoint.",
      },
      disable_markdown_filter: {
        type: "boolean",
        default: false,
        description:
          "Pass through Doubao markdown filtering behavior. Defaults to API-safe false.",
      },
      return_usage: {
        type: "boolean",
        default: true,
        description: "Request usage token data from Volcengine when available.",
      },
      output_path: { type: "string" },
      metadata_path: {
        type: "string",
        description:
          "Where to save the full query JSON. Defaults next to output_path.",
      },
      poll_interval_seconds: {
        type: "number",
        default: 2.0,
        minimum: 0.5,
      },
      timeout_seconds: {
        type: "integer",
        default: 300,
        minimum: 30,
      },
    },
  };

  override output_schema = {
    type: "object",
    properties: {
      output: { type: "string" },
      metadata_path: { type: "string" },
      task_id: { type: "string" },
      audio_duration_seconds: { type: ["number", "null"] },
      sentences: { type: "array" },
      usage: { type: ["object", "null"] },
    },
  };
  override artifact_schema = {
    type: "array",
    items: { type: "string" },
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
    backoff_seconds: 2.0,
    retryable_errors: [
      "timeout",
      "rate_limit",
      "quota exceeded for types: concurrency",
    ],
  };
  override idempotency_key_fields = [
    "text",
    "voice_id",
    "resource_id",
    "speech_rate",
    "sample_rate",
  ];
  override side_effects = [
    "writes audio file to output_path",
    "writes Doubao query metadata JSON next to output_path",
    "calls Volcengine Doubao Speech API",
  ];
  override user_visible_verification = [
    "Listen to generated audio for Mandarin naturalness and pacing",
    "Check timestamp JSON before building subtitles",
  ];
  override quality_score = 0.88;
  override latency_p50_seconds = 8.0;

  static readonly SUBMIT_URL =
    "https://openspeech.bytedance.com/api/v3/tts/submit";
  static readonly QUERY_URL =
    "https://openspeech.bytedance.com/api/v3/tts/query";
  static readonly DEFAULT_RESOURCE_ID = "seed-tts-2.0";
  static readonly DEFAULT_VOICE_ENV = "DOUBAO_SPEECH_VOICE_TYPE";

  override estimateCost(inputs: Record<string, unknown>): number {
    // Volcengine bills Doubao Speech 2.0 by characters. Keep this conservative
    // and prefer provider-returned usage when available.
    const text = (inputs.text as string) ?? "";
    return Math.round(text.length * 0.000015 * 10000) / 10000;
  }

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const apiKey = process.env.DOUBAO_SPEECH_API_KEY;
    if (!apiKey) {
      return toolResult({
        success: false,
        error: "No Doubao Speech API key. " + this.install_instructions,
      });
    }

    const voiceId =
      (inputs.voice_id as string) ||
      process.env[DoubaoTTS.DEFAULT_VOICE_ENV];
    if (!voiceId) {
      return toolResult({
        success: false,
        error:
          "No Doubao voice_id provided. Pass voice_id or set " +
          `${DoubaoTTS.DEFAULT_VOICE_ENV} in the environment.`,
      });
    }

    const start = Date.now();
    let result: ToolResult;
    try {
      result = await this.generate(inputs, apiKey, voiceId);
    } catch (exc) {
      return toolResult({
        success: false,
        error: `Doubao TTS failed: ${this.safeError(exc)}`,
      });
    }

    result.duration_seconds = Math.round((Date.now() - start) / 10) / 100;
    if (!result.cost_usd) {
      result.cost_usd = this.estimateCost(inputs);
    }
    return result;
  }

  private async generate(
    inputs: Record<string, unknown>,
    apiKey: string,
    voiceId: string
  ): Promise<ToolResult> {
    const text = inputs.text as string;
    const fmt = (inputs.format as string) ?? "mp3";
    const resourceId =
      (inputs.resource_id as string) ?? DoubaoTTS.DEFAULT_RESOURCE_ID;
    const outputPath = path.resolve(
      (inputs.output_path as string) ??
        `doubao_tts.${DoubaoTTS.extensionForFormat(fmt)}`
    );
    const metadataPath = path.resolve(
      (inputs.metadata_path as string) || `${outputPath}.json`
    );
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.mkdirSync(path.dirname(metadataPath), { recursive: true });

    const reqId = randomUUID();
    const returnUsage =
      inputs.return_usage !== undefined ? Boolean(inputs.return_usage) : true;
    const headers = this.headers(apiKey, resourceId, reqId, returnUsage);
    const body = this.submitBody(inputs, voiceId, reqId);

    const submitResponse = await fetch(DoubaoTTS.SUBMIT_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const submitData = await DoubaoTTS.jsonOrRaise(submitResponse);
    this.raiseForDoubaoError(submitResponse.status, submitData);

    const taskId = (submitData.data as Record<string, unknown> | undefined)
      ?.task_id as string | undefined;
    if (!taskId) {
      throw new Error("Doubao submit succeeded but did not return data.task_id");
    }

    const queryData = await this.pollQuery(
      apiKey,
      resourceId,
      taskId,
      returnUsage,
      typeof inputs.poll_interval_seconds === "number"
        ? inputs.poll_interval_seconds
        : 2.0,
      typeof inputs.timeout_seconds === "number"
        ? inputs.timeout_seconds
        : 300
    );
    const data = (queryData.data as Record<string, unknown> | undefined) ?? {};
    const audioUrl = data.audio_url as string | undefined;
    if (!audioUrl) {
      throw new Error(
        "Doubao task completed but did not return data.audio_url"
      );
    }

    const audioResponse = await fetch(audioUrl);
    if (!audioResponse.ok) {
      const errBody = await audioResponse.text().catch(() => "");
      throw new Error(
        `HTTP ${audioResponse.status} ${audioResponse.statusText}: ${errBody}`
      );
    }
    fs.writeFileSync(
      outputPath,
      Buffer.from(await audioResponse.arrayBuffer())
    );
    fs.writeFileSync(
      metadataPath,
      JSON.stringify(queryData, null, 2) + "\n",
      "utf-8"
    );

    const audioDuration = await probeDuration(outputPath);
    const usage = data.usage;
    const cost = DoubaoTTS.costFromUsage(usage) ?? this.estimateCost(inputs);

    return toolResult({
      success: true,
      data: {
        provider: this.provider,
        model: resourceId,
        resource_id: resourceId,
        voice_id: voiceId,
        format: fmt,
        sample_rate: inputs.sample_rate ?? 24000,
        speech_rate: inputs.speech_rate ?? 0,
        text_length: text.length,
        task_id: taskId,
        task_status: data.task_status,
        req_text_length: data.req_text_length,
        synthesize_text_length: data.synthesize_text_length,
        audio_duration_seconds:
          audioDuration != null ? Math.round(audioDuration * 100) / 100 : null,
        output: outputPath,
        metadata_path: metadataPath,
        sentences: data.sentences ?? [],
        usage: usage ?? null,
        url_expire_time: data.url_expire_time,
      },
      artifacts: [outputPath, metadataPath],
      cost_usd: cost,
      model: resourceId,
    });
  }

  private headers(
    apiKey: string,
    resourceId: string,
    requestId: string,
    returnUsage: boolean
  ): Record<string, string> {
    const headers: Record<string, string> = {
      "X-Api-Key": apiKey,
      "X-Api-Resource-Id": resourceId,
      "X-Api-Request-Id": requestId,
      "Content-Type": "application/json",
    };
    if (returnUsage) {
      headers["X-Control-Require-Usage-Tokens-Return"] = "true";
    }
    return headers;
  }

  private submitBody(
    inputs: Record<string, unknown>,
    voiceId: string,
    requestId: string
  ): Record<string, unknown> {
    const audioParams = {
      format: inputs.format ?? "mp3",
      sample_rate: inputs.sample_rate ?? 24000,
      speech_rate: inputs.speech_rate ?? 0,
      enable_timestamp:
        inputs.enable_timestamp !== undefined
          ? Boolean(inputs.enable_timestamp)
          : true,
    };
    const additions = {
      disable_markdown_filter: Boolean(inputs.disable_markdown_filter ?? false),
    };
    return {
      user: { uid: inputs.user_id ?? "montagent" },
      unique_id: requestId,
      req_params: {
        text: inputs.text,
        speaker: voiceId,
        audio_params: audioParams,
        additions: JSON.stringify(additions),
      },
    };
  }

  private async pollQuery(
    apiKey: string,
    resourceId: string,
    taskId: string,
    returnUsage: boolean,
    pollInterval: number,
    timeoutSeconds: number
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      await sleep(pollInterval * 1000);
      const headers = this.headers(
        apiKey,
        resourceId,
        randomUUID(),
        returnUsage
      );
      const response = await fetch(DoubaoTTS.QUERY_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({ task_id: taskId }),
      });
      const queryData = await DoubaoTTS.jsonOrRaise(response);
      this.raiseForDoubaoError(response.status, queryData);
      const status = (queryData.data as Record<string, unknown> | undefined)
        ?.task_status;
      if (status === 2) {
        return queryData;
      }
      if (status === 3) {
        throw new Error(
          `Doubao task failed: ${(queryData.message as string) ?? "unknown error"}`
        );
      }
    }
    throw new Error(
      `Doubao task did not finish within ${timeoutSeconds} seconds`
    );
  }

  private static async jsonOrRaise(
    response: Response
  ): Promise<Record<string, unknown>> {
    try {
      return (await response.json()) as Record<string, unknown>;
    } catch {
      throw new Error(
        `Non-JSON response from Doubao API: HTTP ${response.status}`
      );
    }
  }

  private raiseForDoubaoError(
    httpStatus: number,
    payload: Record<string, unknown>
  ): void {
    const code = payload.code;
    if (httpStatus < 400 && code === 20000000) {
      return;
    }
    const message = (payload.message as string) ?? "unknown error";
    const hint = DoubaoTTS.diagnosticHint(message);
    throw new Error(`HTTP ${httpStatus}, code ${code}: ${message}${hint}`);
  }

  private static diagnosticHint(message: string): string {
    const lowered = message.toLowerCase();
    if (
      lowered.includes("load grant") ||
      lowered.includes("requested grant not found")
    ) {
      return " (check DOUBAO_SPEECH_API_KEY and use the new-console X-Api-Key flow)";
    }
    if (
      lowered.includes("speaker permission denied") ||
      lowered.includes("access denied")
    ) {
      return " (check voice_id/DOUBAO_SPEECH_VOICE_TYPE and voice authorization)";
    }
    if (lowered.includes("quota exceeded")) {
      return " (check quota, concurrency, or remaining character package)";
    }
    if (lowered.includes("unsupported additions explicit language")) {
      return " (do not pass additions.explicit_language for this endpoint)";
    }
    return "";
  }

  private safeError(exc: unknown): string {
    // Avoid ever echoing request headers or secrets in user-visible errors.
    const msg = (exc as Error)?.message ?? String(exc);
    const key = process.env.DOUBAO_SPEECH_API_KEY ?? "";
    return key ? msg.split(key).join("[redacted]") : msg;
  }

  private static extensionForFormat(fmt: string): string {
    if (fmt === "ogg_opus") return "ogg";
    if (fmt === "pcm") return "pcm";
    return "mp3";
  }

  private static costFromUsage(usage: unknown): number | null {
    if (typeof usage !== "object" || usage === null) return null;
    const textWords = (usage as Record<string, unknown>).text_words;
    if (typeof textWords !== "number") return null;
    return Math.round(textWords * 0.000015 * 10000) / 10000;
  }
}
