/**
 * Suno AI music generation via sunoapi.org REST API.
 *
 * TypeScript port of tools/audio/suno_music.py. Generates full songs,
 * instrumentals, and background music. Async flow: submit a generation request,
 * poll for completion, download the audio file. Each request produces 2 tracks;
 * the tool returns the first by default.
 *
 * Parity notes vs. Python:
 *  - Python declared dependencies=[] and overrode get_status() to check
 *    SUNO_API_KEY. The TS port uses dependencies=["env:SUNO_API_KEY"] so the base
 *    getStatus() drives availability — behaviorally identical. The in-execute()
 *    key re-check returning an error ToolResult is preserved.
 *  - submit/poll/download are real fetch translations of the requests calls:
 *    same endpoints, headers, JSON/query params, and timeouts (30/30/120s).
 *    time.sleep(POLL_INTERVAL) -> await setTimeout; the poll sleeps BEFORE each
 *    status check, exactly as the Python loop does.
 *  - Status handling (SUCCESS / failure statuses / continue) and the
 *    taskId/data fallbacks match verbatim. Non-2xx -> throw status + body.
 */
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
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

export class SunoMusic extends BaseTool {
  override name = "suno_music";
  override version = "0.1.0";
  override tier = ToolTier.GENERATE;
  override capability = "music_generation";
  override provider = "suno";
  override stability = ToolStability.BETA;
  override execution_mode = ExecutionMode.ASYNC;
  override determinism = Determinism.STOCHASTIC;
  override runtime = ToolRuntime.API;

  override dependencies = ["env:SUNO_API_KEY"];
  override install_instructions =
    "Set the SUNO_API_KEY environment variable:\n" +
    "  export SUNO_API_KEY=your_key_here\n" +
    "Get a key at https://sunoapi.org/api-key";

  override agent_skills = ["music"];

  override capabilities = [
    "generate_background_music",
    "generate_song",
    "generate_instrumental",
  ];
  override supports = {
    instrumental: true,
    vocals: true,
    custom_lyrics: true,
    style_control: true,
    long_form: true,
  };
  override best_for = [
    "full song generation with vocals and lyrics",
    "high-quality instrumental background music",
    "genre-specific music (any genre)",
    "longer tracks up to 8 minutes",
  ];
  override not_good_for = [
    "sound effects (use ElevenLabs SFX instead)",
    "sub-10-second stingers (minimum ~30s generation)",
    "offline generation",
  ];

  override fallback_tools = ["music_gen"];

  override input_schema = {
    type: "object",
    required: ["prompt"],
    properties: {
      prompt: {
        type: "string",
        description:
          "In simple mode: a description of desired music (max 500 chars). " +
          "In custom mode: the exact lyrics to sing (max 3000 chars).",
      },
      style: {
        type: "string",
        description:
          "Genre/style description, e.g. 'upbeat electronic pop'. Used in custom mode only (max 200 chars).",
      },
      title: {
        type: "string",
        description: "Song title. Used in custom mode only (max 80 chars).",
      },
      instrumental: {
        type: "boolean",
        default: true,
        description: "True for instrumental only (no vocals), false for vocals.",
      },
      custom_mode: {
        type: "boolean",
        default: false,
        description:
          "False = simple mode (prompt is a description, lyrics auto-generated). True = custom mode (prompt is exact lyrics, style/title required).",
      },
      model: {
        type: "string",
        enum: ["V4", "V4_5", "V5"],
        default: "V4",
        description: "Suno model version. V4 = 4min max, V4_5/V5 = 8min max.",
      },
      output_path: { type: "string" },
      track_index: {
        type: "integer",
        default: 0,
        enum: [0, 1],
        description: "Which of the 2 generated tracks to return (0 or 1).",
      },
    },
  };

  override resource_profile: ResourceProfile = {
    cpu_cores: 1,
    ram_mb: 256,
    vram_mb: 0,
    disk_mb: 100,
    network_required: true,
  };
  override retry_policy: RetryPolicy = {
    max_retries: 2,
    backoff_seconds: 1.0,
    retryable_errors: ["rate_limit", "timeout"],
  };
  override idempotency_key_fields = ["prompt", "style", "instrumental", "model"];
  override side_effects = [
    "writes audio file to output_path",
    "calls Suno API via sunoapi.org",
  ];
  override user_visible_verification = [
    "Listen to generated music for mood, genre accuracy, and quality",
  ];

  static readonly _BASE_URL = "https://api.sunoapi.org/api/v1";
  static readonly _POLL_INTERVAL = 30; // seconds between status checks
  static readonly _MAX_WAIT = 300; // 5 minutes max wait

  private getApiKey(): string | undefined {
    return process.env.SUNO_API_KEY;
  }

  override estimateCost(_inputs: Record<string, unknown>): number {
    // Suno credits cost $0.005 each; a generation is roughly 10 credits
    return 0.05;
  }

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      return toolResult({
        success: false,
        error: "No Suno API key. " + this.install_instructions,
      });
    }

    const start = Date.now();

    let track: Record<string, unknown>;
    let tracks: Array<Record<string, unknown>>;
    let outputPath: string;
    try {
      // Step 1: Submit generation request
      const taskId = await this.submit(inputs, apiKey);

      // Step 2: Poll for completion
      const resultData = await this.poll(taskId, apiKey);

      // Step 3: Download audio
      const trackIndex = (inputs.track_index as number) ?? 0;
      tracks = (resultData.data as Array<Record<string, unknown>>) ?? [];
      if (tracks.length === 0) {
        return toolResult({ success: false, error: "Suno returned no tracks." });
      }

      track = tracks[Math.min(trackIndex, tracks.length - 1)] as Record<
        string,
        unknown
      >;
      const audioUrl = track.audio_url as string | undefined;
      if (!audioUrl) {
        return toolResult({
          success: false,
          error: "No audio_url in Suno response.",
        });
      }

      outputPath = await this.download(audioUrl, inputs);
    } catch (e) {
      return toolResult({
        success: false,
        error: `Suno generation failed: ${(e as Error).message ?? e}`,
      });
    }

    const duration = Math.round((Date.now() - start) / 10) / 100;

    return toolResult({
      success: true,
      data: {
        provider: "suno",
        model: (inputs.model as string) ?? "V4",
        prompt: inputs.prompt as string,
        style: inputs.style,
        title: track.title ?? inputs.title,
        instrumental: (inputs.instrumental as boolean) ?? true,
        duration_seconds: track.duration,
        output: outputPath,
        format: "mp3",
        track_id: track.id,
        tracks_generated: tracks.length,
      },
      artifacts: [outputPath],
      cost_usd: this.estimateCost(inputs),
      duration_seconds: duration,
      model: `suno/${(inputs.model as string) ?? "V4"}`,
    });
  }

  /** Submit a generation request and return the taskId. */
  private async submit(
    inputs: Record<string, unknown>,
    apiKey: string
  ): Promise<string> {
    const customMode = (inputs.custom_mode as boolean) ?? false;
    const instrumental = (inputs.instrumental as boolean) ?? true;
    const model = (inputs.model as string) ?? "V4";

    const payload: Record<string, unknown> = {
      model,
      customMode,
      instrumental,
      callBackUrl: "", // no webhook; we poll
    };

    if (customMode) {
      payload.prompt = inputs.prompt as string; // exact lyrics
      payload.style = (inputs.style as string) ?? "";
      payload.title = (inputs.title as string) ?? "";
    } else {
      payload.prompt = (inputs.prompt as string).slice(0, 500); // description, max 500 chars
    }

    const response = await fetch(`${SunoMusic._BASE_URL}/generate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${body}`);
    }
    const data = (await response.json()) as Record<string, unknown>;

    const dataObj = (data.data as Record<string, unknown> | undefined) ?? {};
    const taskId =
      (dataObj.taskId as string | undefined) ||
      (data.taskId as string | undefined);
    if (!taskId) {
      throw new Error(`No taskId in Suno response: ${JSON.stringify(data)}`);
    }

    return taskId;
  }

  /** Poll for task completion and return the result data. */
  private async poll(
    taskId: string,
    apiKey: string
  ): Promise<Record<string, unknown>> {
    let elapsed = 0;
    while (elapsed < SunoMusic._MAX_WAIT) {
      await sleep(SunoMusic._POLL_INTERVAL * 1000);
      elapsed += SunoMusic._POLL_INTERVAL;

      const url = new URL(`${SunoMusic._BASE_URL}/generate/record-info`);
      url.searchParams.set("taskId", taskId);

      const response = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `HTTP ${response.status} ${response.statusText}: ${body}`
        );
      }
      const result = (await response.json()) as Record<string, unknown>;

      const dataObj =
        (result.data as Record<string, unknown> | undefined) ?? {};
      const status =
        (dataObj.status as string | undefined) ||
        (result.status as string | undefined) ||
        "";

      if (status === "SUCCESS") {
        return (result.data as Record<string, unknown> | undefined) ?? result;
      } else if (
        status === "CREATE_TASK_FAILED" ||
        status === "GENERATE_AUDIO_FAILED" ||
        status === "SENSITIVE_WORD_ERROR"
      ) {
        throw new Error(`Suno generation failed with status: ${status}`);
      }

      // PENDING, GENERATING, TEXT_SUCCESS, FIRST_SUCCESS — keep polling
    }

    throw new Error(
      `Suno generation timed out after ${SunoMusic._MAX_WAIT}s (taskId: ${taskId})`
    );
  }

  /** Download the audio file to the output path. */
  private async download(
    audioUrl: string,
    inputs: Record<string, unknown>
  ): Promise<string> {
    const outputPath = path.resolve(
      (inputs.output_path as string) ?? "suno_output.mp3"
    );
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const response = await fetch(audioUrl, {
      method: "GET",
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${body}`);
    }
    fs.writeFileSync(outputPath, Buffer.from(await response.arrayBuffer()));

    return outputPath;
  }
}
