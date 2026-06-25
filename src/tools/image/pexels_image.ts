/**
 * Stock image acquisition from Pexels API (free).
 *
 * TypeScript port of tools/graphics/pexels_image.py. Faithful contract
 * (capability="image_generation", provider="pexels", runtime API, tier SOURCE)
 * plus a real fetch translation of the Python requests flow: GET the search
 * endpoint with the Authorization header and query params, pick the first
 * photo, download the chosen size, and write it to disk.
 *
 * Parity notes vs. Python:
 *  - Python declared dependencies=[] and overrode get_status() to check
 *    PEXELS_API_KEY directly. The TS port declares
 *    dependencies=["env:PEXELS_API_KEY"] so the base getStatus() drives
 *    preflight availability — behaviorally identical (UNAVAILABLE without the
 *    key) and keeps pexels in setup_offers.
 *  - Endpoint, Authorization header, query params (including the per_page/page
 *    defaults and optional orientation/size/color), download-size fallback to
 *    large2x, default output filename (pexels_<id>.jpg), the no-results error
 *    (which still carries total_results in data), and the success payload all
 *    match the Python verbatim. cost is always 0 (Pexels is free).
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

interface PexelsPhoto {
  id: number;
  src: Record<string, string>;
  photographer?: string;
  photographer_url?: string;
  alt?: string;
  width?: number;
  height?: number;
  url?: string;
}

export class PexelsImage extends BaseTool {
  override name = "pexels_image";
  override version = "0.1.0";
  override tier = ToolTier.SOURCE;
  override capability = "image_generation";
  override provider = "pexels";
  override stability = ToolStability.BETA;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;
  override runtime = ToolRuntime.API;

  override dependencies = ["env:PEXELS_API_KEY"];
  override install_instructions =
    "Set PEXELS_API_KEY to your Pexels API key.\n" +
    "  Get one free at https://www.pexels.com/api/";
  override agent_skills = [];

  override capabilities = ["search_image", "download_image", "stock_image"];
  override supports = {
    orientation_filter: true,
    size_filter: true,
    color_filter: true,
    locale: true,
    free_commercial_use: true,
  };
  override best_for = [
    "real-world photography (cities, nature, people, objects)",
    "establishing shots and B-roll stills",
    "free stock images — no cost, no attribution required",
  ];
  override not_good_for = [
    "custom/specific compositions",
    "abstract or stylized graphics",
    "offline use",
  ];

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
        description: "large=24MP+, medium=12MP+, small=4MP+",
      },
      color: {
        type: "string",
        description: "Hex without # (e.g. FF0000) or color name (red, blue, etc.)",
      },
      per_page: { type: "integer", default: 5, minimum: 1, maximum: 80 },
      page: { type: "integer", default: 1 },
      download_size: {
        type: "string",
        enum: ["original", "large2x", "large", "medium"],
        default: "large2x",
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
  override idempotency_key_fields = ["query", "orientation", "size", "color", "page"];
  override side_effects = ["writes image file to output_path", "calls Pexels API"];
  override user_visible_verification = [
    "Check that downloaded image matches the intended scene",
  ];

  override estimateCost(_inputs: Record<string, unknown>): number {
    return 0.0; // Pexels is free
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

    const url = new URL("https://api.pexels.com/v1/search");
    url.searchParams.set("query", query);
    url.searchParams.set("per_page", String((inputs.per_page as number) ?? 5));
    url.searchParams.set("page", String((inputs.page as number) ?? 1));
    if (inputs.orientation)
      url.searchParams.set("orientation", inputs.orientation as string);
    if (inputs.size) url.searchParams.set("size", inputs.size as string);
    if (inputs.color) url.searchParams.set("color", inputs.color as string);

    let photo: PexelsPhoto;
    let data: { photos?: PexelsPhoto[]; total_results?: number };
    let outputPath: string;
    try {
      const searchResponse = await fetch(url, {
        headers: { Authorization: apiKey },
      });
      if (!searchResponse.ok) {
        const body = await searchResponse.text().catch(() => "");
        throw new Error(
          `HTTP ${searchResponse.status} ${searchResponse.statusText}: ${body}`
        );
      }
      data = (await searchResponse.json()) as {
        photos?: PexelsPhoto[];
        total_results?: number;
      };

      const photos = data.photos ?? [];
      if (photos.length === 0) {
        return toolResult({
          success: false,
          error: `No images found for query: ${query}`,
          data: { total_results: data.total_results ?? 0 },
        });
      }

      // Pick the first result (agent can refine query if needed)
      photo = photos[0]!;
      const downloadSize = (inputs.download_size as string) ?? "large2x";
      const imageUrl = photo.src[downloadSize] ?? photo.src.large2x!;

      const imageResponse = await fetch(imageUrl);
      if (!imageResponse.ok) {
        throw new Error(
          `HTTP ${imageResponse.status} ${imageResponse.statusText} downloading ${imageUrl}`
        );
      }

      outputPath = (inputs.output_path as string) ?? `pexels_${photo.id}.jpg`;
      fs.mkdirSync(path.dirname(outputPath) || ".", { recursive: true });
      fs.writeFileSync(outputPath, Buffer.from(await imageResponse.arrayBuffer()));
    } catch (e) {
      return toolResult({
        success: false,
        error: `Pexels image search failed: ${(e as Error).message ?? e}`,
      });
    }

    return toolResult({
      success: true,
      data: {
        provider: "pexels",
        photo_id: photo.id,
        photographer: photo.photographer ?? "Unknown",
        photographer_url: photo.photographer_url ?? "",
        alt: photo.alt ?? "",
        width: photo.width,
        height: photo.height,
        query,
        output: outputPath,
        total_results: data.total_results ?? 0,
        results_returned: (data.photos ?? []).length,
        license: "Pexels License (free, no attribution required)",
        pexels_url: photo.url ?? "",
      },
      artifacts: [outputPath],
      cost_usd: 0.0,
      duration_seconds: Math.round((Date.now() - start) / 10) / 100,
    });
  }
}
