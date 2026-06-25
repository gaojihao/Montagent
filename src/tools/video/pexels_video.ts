/**
 * Stock video acquisition from Pexels API (free).
 *
 * TypeScript port of tools/video/pexels_video.py. execute() is a real
 * fetch-based translation of the Python requests flow (search -> pick best file
 * -> download to disk).
 *
 * Parity notes vs. Python:
 *  - Python declared dependencies=[] and overrode get_status() to check
 *    PEXELS_API_KEY directly. The TS port declares
 *    dependencies=["env:PEXELS_API_KEY"] so the base getStatus() drives
 *    availability (UNAVAILABLE without the key) — behaviorally identical.
 *  - Endpoint, headers (Authorization: <api_key>), query params, duration
 *    filtering, video-file selection (sort by width desc, prefer quality match,
 *    else first), result data fields, and zero cost all match the Python verbatim.
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

export class PexelsVideo extends BaseTool {
  override name = "pexels_video";
  override version = "0.1.0";
  override tier = ToolTier.SOURCE;
  override capability = "video_generation";
  override provider = "pexels";
  override stability = ToolStability.BETA;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;
  override runtime = ToolRuntime.API;

  override dependencies = ["env:PEXELS_API_KEY"];
  override install_instructions =
    "Set PEXELS_API_KEY to your Pexels API key.\n" +
    "  Get one free at https://www.pexels.com/api/";
  override agent_skills: string[] = [];

  override capabilities = ["search_video", "download_video", "stock_video"];
  override supports = {
    orientation_filter: true,
    size_filter: true,
    free_commercial_use: true,
  };
  override best_for = [
    "real-world B-roll footage (cities, nature, people, offices)",
    "establishing shots and transitions",
    "free stock video — no cost, no attribution required",
  ];
  override not_good_for = [
    "custom/specific scenes",
    "animated or stylized content",
    "offline use",
  ];
  override fallback_tools = ["pixabay_video"];

  override input_schema = {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string", description: "Search term" },
      orientation: {
        type: "string",
        enum: ["landscape", "portrait", "square"],
      },
      size: {
        type: "string",
        enum: ["large", "medium", "small"],
        description: "large=4K, medium=Full HD, small=HD",
      },
      min_duration: {
        type: "integer",
        description: "Minimum duration in seconds",
      },
      max_duration: {
        type: "integer",
        description: "Maximum duration in seconds",
      },
      per_page: { type: "integer", default: 5, minimum: 1, maximum: 80 },
      page: { type: "integer", default: 1 },
      preferred_quality: {
        type: "string",
        enum: ["hd", "sd"],
        default: "hd",
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
  override idempotency_key_fields = ["query", "orientation", "size", "page"];
  override side_effects = [
    "writes video file to output_path",
    "calls Pexels API",
  ];
  override user_visible_verification = [
    "Watch downloaded clip to verify it matches the intended scene",
  ];

  override estimateCost(_inputs: Record<string, unknown>): number {
    return 0.0;
  }

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const apiKey = process.env.PEXELS_API_KEY;
    if (!apiKey) {
      return toolResult({
        success: false,
        error: "PEXELS_API_KEY not set. " + this.install_instructions,
      });
    }

    const start = Date.now();
    const query = inputs.query as string;

    const url = new URL("https://api.pexels.com/videos/search");
    url.searchParams.set("query", query);
    url.searchParams.set("per_page", String((inputs.per_page as number) ?? 5));
    url.searchParams.set("page", String((inputs.page as number) ?? 1));
    if (inputs.orientation) url.searchParams.set("orientation", inputs.orientation as string);
    if (inputs.size) url.searchParams.set("size", inputs.size as string);

    let video: Record<string, any>;
    let selectedFile: Record<string, any>;
    let data: Record<string, any>;
    let videosCount: number;
    let outputPath: string;

    try {
      const searchResponse = await fetch(url, {
        method: "GET",
        headers: { Authorization: apiKey },
        signal: AbortSignal.timeout(30000),
      });
      if (!searchResponse.ok) {
        const body = await searchResponse.text().catch(() => "");
        throw new Error(`HTTP ${searchResponse.status} ${searchResponse.statusText}: ${body}`);
      }
      data = (await searchResponse.json()) as Record<string, any>;

      let videos: Array<Record<string, any>> = data.videos ?? [];

      // Filter by duration if specified
      const minDur = inputs.min_duration as number | undefined;
      const maxDur = inputs.max_duration as number | undefined;
      if (minDur || maxDur) {
        const filtered: Array<Record<string, any>> = [];
        for (const v of videos) {
          const dur = (v.duration as number) ?? 0;
          if (minDur && dur < minDur) continue;
          if (maxDur && dur > maxDur) continue;
          filtered.push(v);
        }
        videos = filtered;
      }

      if (videos.length === 0) {
        return toolResult({
          success: false,
          error: `No videos found for query: ${query}`,
          data: { total_results: data.total_results ?? 0 },
        });
      }

      video = videos[0]!;
      const preferredQuality = (inputs.preferred_quality as string) ?? "hd";

      // Pick the best matching video file
      const videoFiles: Array<Record<string, any>> = video.video_files ?? [];
      let selected: Record<string, any> | null = null;
      const sorted = [...videoFiles].sort(
        (a, b) => ((b.width as number) ?? 0) - ((a.width as number) ?? 0)
      );
      for (const vf of sorted) {
        if (vf.quality === preferredQuality) {
          selected = vf;
          break;
        }
      }
      if (!selected && videoFiles.length > 0) selected = videoFiles[0]!;

      if (!selected) {
        return toolResult({ success: false, error: "No downloadable video file found." });
      }
      selectedFile = selected;

      const videoUrl = selectedFile.link as string;
      const videoResponse = await fetch(videoUrl, { signal: AbortSignal.timeout(120000) });
      if (!videoResponse.ok) {
        const body = await videoResponse.text().catch(() => "");
        throw new Error(`HTTP ${videoResponse.status} ${videoResponse.statusText}: ${body}`);
      }

      outputPath = (inputs.output_path as string) ?? `pexels_video_${video.id}.mp4`;
      fs.mkdirSync(path.dirname(path.resolve(outputPath)) || ".", { recursive: true });
      fs.writeFileSync(outputPath, Buffer.from(await videoResponse.arrayBuffer()));

      videosCount = videos.length;
    } catch (e) {
      return toolResult({
        success: false,
        error: `Pexels video search failed: ${(e as Error).message ?? e}`,
      });
    }

    return toolResult({
      success: true,
      data: {
        provider: "pexels",
        video_id: video.id,
        user: video.user?.name ?? "Unknown",
        duration_seconds: video.duration,
        width: selectedFile.width,
        height: selectedFile.height,
        fps: selectedFile.fps,
        quality: selectedFile.quality,
        query,
        output: outputPath,
        total_results: data.total_results ?? 0,
        results_returned: videosCount,
        license: "Pexels License (free, no attribution required)",
        pexels_url: video.url ?? "",
      },
      artifacts: [outputPath],
      cost_usd: 0.0,
      duration_seconds: Math.round((Date.now() - start) / 10) / 100,
    });
  }
}
