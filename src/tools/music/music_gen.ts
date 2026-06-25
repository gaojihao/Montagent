/**
 * Music generation tool via ElevenLabs Music API.
 *
 * TypeScript port of tools/audio/music_gen.py. Generates background music and
 * sound effects for video production. Reports unavailable when no API key is
 * configured.
 *
 * Parity notes vs. Python:
 *  - Python declared dependencies=[] and overrode get_status() to check
 *    ELEVENLABS_API_KEY directly. The TS port uses
 *    dependencies=["env:ELEVENLABS_API_KEY"] so the base getStatus() drives
 *    availability — behaviorally identical (UNAVAILABLE without the key). The
 *    in-execute() key re-check that returns an error ToolResult is preserved.
 *  - execute() is a real fetch translation of the Python requests.post call:
 *    same endpoint, headers, JSON body (prompt, music_length_ms), 180s timeout,
 *    and the download-to-file behavior. Non-2xx -> throw status + body.
 *  - estimateCost throws when duration_seconds is missing, mirroring the Python
 *    ValueError. execute() checks duration first and returns an error ToolResult
 *    before estimateCost is reached, so the throw only surfaces on direct calls.
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

export class MusicGen extends BaseTool {
  override name = "music_gen";
  override version = "0.1.0";
  override tier = ToolTier.GENERATE;
  override capability = "music_generation";
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

  override agent_skills = ["music", "sound-effects", "elevenlabs"];

  override capabilities = ["generate_background_music", "generate_sfx"];

  override input_schema = {
    type: "object",
    required: ["prompt"],
    properties: {
      prompt: {
        type: "string",
        description: "Music description (mood, genre, instruments, tempo)",
      },
      duration_seconds: {
        type: "number",
        minimum: 3,
        maximum: 600,
        description:
          "Target duration in seconds (API supports 3-600s). " +
          "Should match the target video duration from the script/proposal. " +
          "Omitting this defaults to 60s which may not match your video.",
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
  override idempotency_key_fields = ["prompt", "duration_seconds"];
  override side_effects = [
    "writes audio file to output_path",
    "calls ElevenLabs API",
  ];
  override user_visible_verification = [
    "Listen to generated music for mood and quality",
  ];

  override estimateCost(inputs: Record<string, unknown>): number {
    // ElevenLabs music generation pricing is per generation
    const duration = inputs.duration_seconds as number | undefined;
    if (duration === undefined || duration === null) {
      throw new Error(
        "music_gen.estimate_cost: duration_seconds is required. " +
          "Derive it from the approved target runtime in the script/proposal. " +
          "Silent defaults are not permitted."
      );
    }
    // Approximate: ~$0.05 per 30 seconds
    return Math.round((duration / 30) * 0.05 * 10000) / 10000;
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
    } catch (e) {
      return toolResult({
        success: false,
        error: `Music generation failed: ${(e as Error).message ?? e}`,
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
    const prompt = inputs.prompt as string;
    const duration = inputs.duration_seconds as number | undefined;
    if (duration === undefined || duration === null) {
      return toolResult({
        success: false,
        error:
          "music_gen: duration_seconds is required. " +
          "Derive it from the approved target runtime in the script/proposal. " +
          "Silent defaults to 60s are not permitted — the generated music " +
          "must match the actual video duration.",
      });
    }

    const url = "https://api.elevenlabs.io/v1/music";

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt,
        music_length_ms: Math.trunc(duration * 1000),
      }),
      signal: AbortSignal.timeout(180000),
    });

    if (!response.ok) {
      // Mirror requests.raise_for_status(): surface status + body.
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${body}`);
    }

    const outputPath = path.resolve(
      (inputs.output_path as string) ?? "music_output.mp3"
    );
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, Buffer.from(await response.arrayBuffer()));

    return toolResult({
      success: true,
      data: {
        provider: "elevenlabs",
        prompt,
        duration_seconds: duration,
        output: outputPath,
        format: "mp3",
      },
      artifacts: [outputPath],
    });
  }
}
