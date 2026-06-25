/**
 * Stock video acquisition from Pixabay API (free).
 *
 * TypeScript port of tools/video/pixabay_video.py. execute() is a real
 * fetch-based translation of the Python requests flow (search -> pick best
 * quality variant -> download to disk before the URL expires).
 *
 * Parity notes vs. Python:
 *  - Python declared dependencies=[] and overrode get_status() to check
 *    PIXABAY_API_KEY directly. The TS port declares
 *    dependencies=["env:PIXABAY_API_KEY"] so the base getStatus() drives
 *    availability — behaviorally identical.
 *  - Endpoint, query params (key/q/per_page/page/safesearch as lowercase
 *    string, optional video_type/category/editors_choice), duration filtering,
 *    quality-variant selection with fallback order, result data fields, and zero
 *    cost all match the Python verbatim.
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

export class PixabayVideo extends BaseTool {
  override name = "pixabay_video";
  override version = "0.1.0";
  override tier = ToolTier.SOURCE;
  override capability = "video_generation";
  override provider = "pixabay";
  override stability = ToolStability.BETA;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;
  override runtime = ToolRuntime.API;

  override dependencies = ["env:PIXABAY_API_KEY"];
  override install_instructions =
    "Set PIXABAY_API_KEY to your Pixabay API key.\n" +
    "  Get one free at https://pixabay.com/api/docs/";
  override agent_skills: string[] = [];

  override capabilities = ["search_video", "download_video", "stock_video"];
  override supports = {
    video_type_filter: true,
    category_filter: true,
    editors_choice: true,
    free_commercial_use: true,
  };
  override best_for = [
    "large royalty-free video library",
    "category-based filtering",
    "free stock video — no cost, no attribution required",
  ];
  override not_good_for = [
    "4K footage (max 1080p on standard API)",
    "custom scenes",
    "offline use",
  ];
  override fallback_tools = ["pexels_video"];

  override input_schema = {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string", description: "Search term (max 100 chars)" },
      video_type: {
        type: "string",
        enum: ["all", "film", "animation"],
        default: "all",
      },
      category: {
        type: "string",
        enum: [
          "backgrounds", "fashion", "nature", "science", "education",
          "feelings", "health", "people", "religion", "places",
          "animals", "industry", "computer", "food", "sports",
          "transportation", "travel", "buildings", "business", "music",
        ],
      },
      min_duration: {
        type: "integer",
        description: "Minimum duration in seconds",
      },
      max_duration: {
        type: "integer",
        description: "Maximum duration in seconds",
      },
      editors_choice: { type: "boolean", default: false },
      safesearch: { type: "boolean", default: true },
      per_page: { type: "integer", default: 5, minimum: 3, maximum: 200 },
      page: { type: "integer", default: 1 },
      preferred_quality: {
        type: "string",
        enum: ["large", "medium", "small", "tiny"],
        default: "large",
      },
      output_path: { type: "string" },
    },
  };

  override resource_profile: ResourceProfile = {
    cpu_cores: 1,
    ram_mb: 256,
    vram_mb: 0,
    disk_mb: 200,
    network_required: true,
  };
  override retry_policy: RetryPolicy = {
    max_retries: 2,
    backoff_seconds: 1.0,
    retryable_errors: ["rate_limit", "timeout"],
  };
  override idempotency_key_fields = ["query", "video_type", "category", "page"];
  override side_effects = [
    "writes video file to output_path",
    "calls Pixabay API",
  ];
  override user_visible_verification = [
    "Watch downloaded clip to verify it matches the intended scene",
  ];

  override estimateCost(_inputs: Record<string, unknown>): number {
    return 0.0;
  }

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const apiKey = process.env.PIXABAY_API_KEY;
    if (!apiKey) {
      return toolResult({
        success: false,
        error: "PIXABAY_API_KEY not set. " + this.install_instructions,
      });
    }

    const start = Date.now();
    const query = inputs.query as string;

    const url = new URL("https://pixabay.com/api/videos/");
    url.searchParams.set("key", apiKey);
    url.searchParams.set("q", query);
    url.searchParams.set("per_page", String((inputs.per_page as number) ?? 5));
    url.searchParams.set("page", String((inputs.page as number) ?? 1));
    url.searchParams.set(
      "safesearch",
      String((inputs.safesearch as boolean) ?? true).toLowerCase()
    );
    if (inputs.video_type && inputs.video_type !== "all") {
      url.searchParams.set("video_type", inputs.video_type as string);
    }
    if (inputs.category) url.searchParams.set("category", inputs.category as string);
    if (inputs.editors_choice) url.searchParams.set("editors_choice", "true");

    let hit: Record<string, any>;
    let videoInfo: Record<string, any>;
    let data: Record<string, any>;
    let hitsCount: number;
    let outputPath: string;

    try {
      const searchResponse = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(30000),
      });
      if (!searchResponse.ok) {
        const body = await searchResponse.text().catch(() => "");
        throw new Error(`HTTP ${searchResponse.status} ${searchResponse.statusText}: ${body}`);
      }
      data = (await searchResponse.json()) as Record<string, any>;

      let hits: Array<Record<string, any>> = data.hits ?? [];

      // Filter by duration if specified
      const minDur = inputs.min_duration as number | undefined;
      const maxDur = inputs.max_duration as number | undefined;
      if (minDur || maxDur) {
        const filtered: Array<Record<string, any>> = [];
        for (const h of hits) {
          const dur = (h.duration as number) ?? 0;
          if (minDur && dur < minDur) continue;
          if (maxDur && dur > maxDur) continue;
          filtered.push(h);
        }
        hits = filtered;
      }

      if (hits.length === 0) {
        return toolResult({
          success: false,
          error: `No videos found for query: ${query}`,
          data: { total_results: data.total ?? 0 },
        });
      }

      hit = hits[0]!;
      const preferred = (inputs.preferred_quality as string) ?? "large";
      let info: Record<string, any> | undefined = hit.videos?.[preferred];
      if (!info) {
        // Fallback to best available
        for (const quality of ["large", "medium", "small", "tiny"]) {
          info = hit.videos?.[quality];
          if (info) break;
        }
      }

      if (!info) {
        return toolResult({ success: false, error: "No downloadable video file found." });
      }
      videoInfo = info;

      // Download immediately — Pixabay URLs expire
      const videoUrl = videoInfo.url as string;
      const videoResponse = await fetch(videoUrl, { signal: AbortSignal.timeout(120000) });
      if (!videoResponse.ok) {
        const body = await videoResponse.text().catch(() => "");
        throw new Error(`HTTP ${videoResponse.status} ${videoResponse.statusText}: ${body}`);
      }

      outputPath = (inputs.output_path as string) ?? `pixabay_video_${hit.id}.mp4`;
      fs.mkdirSync(path.dirname(path.resolve(outputPath)) || ".", { recursive: true });
      fs.writeFileSync(outputPath, Buffer.from(await videoResponse.arrayBuffer()));

      hitsCount = hits.length;
    } catch (e) {
      return toolResult({
        success: false,
        error: `Pixabay video search failed: ${(e as Error).message ?? e}`,
      });
    }

    return toolResult({
      success: true,
      data: {
        provider: "pixabay",
        video_id: hit.id,
        user: hit.user ?? "Unknown",
        tags: hit.tags ?? "",
        duration_seconds: hit.duration,
        width: videoInfo.width,
        height: videoInfo.height,
        query,
        output: outputPath,
        total_results: data.total ?? 0,
        results_returned: hitsCount,
        license: "Pixabay Content License (free, no attribution required)",
        page_url: hit.pageURL ?? "",
      },
      artifacts: [outputPath],
      cost_usd: 0.0,
      duration_seconds: Math.round((Date.now() - start) / 10) / 100,
    });
  }
}
