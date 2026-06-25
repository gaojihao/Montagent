/**
 * Music search and download from Freesound.org (free with API key).
 *
 * TypeScript port of tools/audio/freesound_music.py. Searches Freesound's
 * library of Creative Commons audio and downloads high-quality MP3 previews for
 * use as background music.
 *
 * Parity notes vs. Python:
 *  - Python declared dependencies=[] and overrode get_status() to check
 *    FREESOUND_API_KEY. The TS port uses dependencies=["env:FREESOUND_API_KEY"]
 *    so the base getStatus() drives availability — behaviorally identical. The
 *    in-execute() key re-check returning an error ToolResult is preserved.
 *  - The urllib search/download calls are translated to fetch with the same
 *    User-Agent header, query params (query, filter, sort, fields, token,
 *    page_size), and timeouts (30s search / 60s download). Non-2xx -> throw.
 *  - The safe-filename builder uses a Unicode letter/number class to mirror
 *    Python str.isalnum() (which is Unicode-aware), keeping the allowed set
 *    "._- " plus space.
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

const USER_AGENT = "Montagent/0.1 (music acquisition tool)";

export class FreesoundMusic extends BaseTool {
  override name = "freesound_music";
  override version = "0.1.0";
  override tier = ToolTier.SOURCE;
  override capability = "music_search";
  override provider = "freesound";
  override stability = ToolStability.BETA;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;
  override runtime = ToolRuntime.API;

  override dependencies = ["env:FREESOUND_API_KEY"];
  override install_instructions =
    "Set the FREESOUND_API_KEY environment variable:\n" +
    "  export FREESOUND_API_KEY=your_key_here\n" +
    "Get a free key at https://freesound.org/apiv2/apply/";

  override agent_skills = ["music"];

  override capabilities = ["search_music", "download_music", "stock_music"];
  override supports = {
    duration_filter: true,
    rating_sort: true,
    tag_metadata: true,
    free_creative_commons: true,
  };
  override best_for = [
    "ambient and atmospheric background music",
    "free Creative Commons licensed audio",
    "searching by mood, genre, or instrument tags",
    "finding loops, drones, and textural audio",
  ];
  override not_good_for = [
    "full produced songs with vocals",
    "commercially licensed music (check individual CC licenses)",
    "offline use",
  ];

  override fallback_tools = ["pixabay_music", "music_gen"];

  override input_schema = {
    type: "object",
    required: ["query"],
    properties: {
      query: {
        type: "string",
        description:
          "Search query describing desired music mood/genre (e.g., 'dark ambient cinematic underwater')",
      },
      min_duration: {
        type: "number",
        default: 30,
        minimum: 1,
        description: "Minimum duration in seconds",
      },
      max_duration: {
        type: "number",
        default: 120,
        maximum: 600,
        description: "Maximum duration in seconds",
      },
      output_path: {
        type: "string",
        description: "File path to save the downloaded MP3",
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
  override idempotency_key_fields = ["query", "min_duration", "max_duration"];
  override side_effects = [
    "writes audio file to output_path",
    "calls Freesound API",
  ];
  override user_visible_verification = [
    "Listen to downloaded track for mood and quality",
    "Check Creative Commons license terms for your use case",
  ];

  static readonly _BASE_URL = "https://freesound.org/apiv2";

  override estimateCost(_inputs: Record<string, unknown>): number {
    return 0.0; // Freesound is free
  }

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const apiKey = process.env.FREESOUND_API_KEY;
    if (!apiKey) {
      return toolResult({
        success: false,
        error: "FREESOUND_API_KEY not set. " + this.install_instructions,
      });
    }

    const start = Date.now();

    let sound: Record<string, unknown>;
    let searchResult: Array<Record<string, unknown>>;
    let outputPath: string;
    try {
      // Step 1: Search for matching sounds
      searchResult = await this.search(inputs, apiKey);
      if (searchResult.length === 0) {
        return toolResult({
          success: false,
          error: `No music found on Freesound for query: ${inputs.query as string}`,
          data: { query: inputs.query },
          duration_seconds: Math.round((Date.now() - start) / 10) / 100,
        });
      }

      // Step 2: Pick the top result (sorted by rating)
      sound = searchResult[0] as Record<string, unknown>;

      // Step 3: Download the HQ MP3 preview
      outputPath = await this.download(sound, inputs);
    } catch (e) {
      return toolResult({
        success: false,
        error: `Freesound music search failed: ${(e as Error).message ?? e}`,
        duration_seconds: Math.round((Date.now() - start) / 10) / 100,
      });
    }

    return toolResult({
      success: true,
      data: {
        provider: "freesound",
        sound_id: sound.id,
        name: sound.name ?? "Unknown",
        duration_seconds: sound.duration,
        avg_rating: sound.avg_rating,
        tags: sound.tags ?? [],
        query: inputs.query,
        output: outputPath,
        format: "mp3",
        license: "Creative Commons (check individual sound license)",
        freesound_url: `https://freesound.org/people/${
          (sound.username as string) ?? ""
        }/sounds/${(sound.id as string | number) ?? ""}/`,
        results_found: searchResult.length,
      },
      artifacts: [outputPath],
      cost_usd: 0.0,
      duration_seconds: Math.round((Date.now() - start) / 10) / 100,
    });
  }

  /** Search Freesound for sounds matching the query and duration filter. */
  private async search(
    inputs: Record<string, unknown>,
    apiKey: string
  ): Promise<Array<Record<string, unknown>>> {
    const query = inputs.query as string;
    const minDur = (inputs.min_duration as number) ?? 30;
    const maxDur = (inputs.max_duration as number) ?? 120;

    const url = new URL(`${FreesoundMusic._BASE_URL}/search/text/`);
    url.searchParams.set("query", query);
    url.searchParams.set("filter", `duration:[${minDur} TO ${maxDur}]`);
    url.searchParams.set("sort", "rating_desc");
    url.searchParams.set(
      "fields",
      "id,name,duration,previews,tags,avg_rating,username"
    );
    url.searchParams.set("token", apiKey);
    url.searchParams.set("page_size", "15");

    const response = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${body}`);
    }
    const data = (await response.json()) as Record<string, unknown>;

    return (data.results as Array<Record<string, unknown>>) ?? [];
  }

  /** Download the HQ MP3 preview of a Freesound sound. */
  private async download(
    sound: Record<string, unknown>,
    inputs: Record<string, unknown>
  ): Promise<string> {
    const previews = (sound.previews as Record<string, unknown>) ?? {};
    // Prefer the HQ MP3 preview; fall back to LQ MP3
    const audioUrl =
      (previews["preview-hq-mp3"] as string | undefined) ||
      (previews["preview-lq-mp3"] as string | undefined);

    if (!audioUrl) {
      throw new Error(
        `No preview URL available for sound ${sound.id} (${sound.name})`
      );
    }

    // Build output path
    const soundName =
      (sound.name as string | undefined) ?? `freesound_${sound.id ?? "unknown"}`;
    const safeName = sanitizeFilename(soundName);
    const defaultFilename = `freesound_${sound.id}_${safeName}.mp3`;
    const outputPath = path.resolve(
      (inputs.output_path as string) ?? defaultFilename
    );
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const response = await fetch(audioUrl, {
      method: "GET",
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${body}`);
    }
    fs.writeFileSync(outputPath, Buffer.from(await response.arrayBuffer()));

    return outputPath;
  }
}

/**
 * Port of the Python comprehension:
 *   "".join(c if c.isalnum() or c in "._- " else "_" for c in name)
 * Python str.isalnum() is Unicode-aware, so the allowed set is any Unicode
 * letter/number plus the literal characters in "._- " (dot, underscore, dash,
 * space). Everything else becomes "_".
 */
function sanitizeFilename(name: string): string {
  return name.replace(/[^\p{L}\p{N}._\- ]/gu, "_");
}
