/**
 * Stock image acquisition from Pixabay API (free).
 *
 * TypeScript port of tools/graphics/pixabay_image.py. Faithful contract
 * (capability="image_generation", provider="pixabay", runtime API, tier SOURCE)
 * plus a real fetch translation of the Python requests flow: GET the search
 * endpoint with the api key as a query param, pick the first hit, download the
 * best available URL immediately (Pixabay URLs carry expiring tokens), and
 * write it to disk.
 *
 * Parity notes vs. Python:
 *  - Python declared dependencies=[] and overrode get_status() to check
 *    PIXABAY_API_KEY directly. The TS port declares
 *    dependencies=["env:PIXABAY_API_KEY"] so the base getStatus() drives
 *    preflight availability — behaviorally identical (UNAVAILABLE without the
 *    key) and keeps pixabay in setup_offers.
 *  - Endpoint, query params (key/q/per_page/page/safesearch plus the optional
 *    image_type/orientation/category/colors/editors_choice with their
 *    "all"-means-omit semantics), the largeImageURL->webformatURL fallback,
 *    default output filename (pixabay_<id>.jpg), the no-results error (carrying
 *    total in data), and the success payload all match the Python verbatim.
 *    cost is always 0 (Pixabay is free).
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

interface PixabayHit {
  id: number;
  largeImageURL?: string;
  webformatURL?: string;
  user?: string;
  tags?: string;
  imageWidth?: number;
  imageHeight?: number;
  pageURL?: string;
}

export class PixabayImage extends BaseTool {
  override name = "pixabay_image";
  override version = "0.1.0";
  override tier = ToolTier.SOURCE;
  override capability = "image_generation";
  override provider = "pixabay";
  override stability = ToolStability.BETA;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;
  override runtime = ToolRuntime.API;

  override dependencies = ["env:PIXABAY_API_KEY"];
  override install_instructions =
    "Set PIXABAY_API_KEY to your Pixabay API key.\n" +
    "  Get one free at https://pixabay.com/api/docs/";
  override agent_skills = [];

  override capabilities = ["search_image", "download_image", "stock_image"];
  override supports = {
    orientation_filter: true,
    category_filter: true,
    color_filter: true,
    image_type_filter: true,
    editors_choice: true,
    free_commercial_use: true,
  };
  override best_for = [
    "large royalty-free library (5M+ images)",
    "category-based filtering (nature, business, science, etc.)",
    "free stock images — no cost, no attribution required",
  ];
  override not_good_for = [
    "full-resolution originals (standard API limited to 1280px)",
    "custom compositions",
    "offline use",
  ];

  override input_schema = {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string", description: "Search term (max 100 chars)" },
      image_type: {
        type: "string",
        enum: ["all", "photo", "illustration", "vector"],
        default: "all",
      },
      orientation: {
        type: "string",
        enum: ["all", "horizontal", "vertical"],
        default: "all",
      },
      category: {
        type: "string",
        enum: [
          "backgrounds",
          "fashion",
          "nature",
          "science",
          "education",
          "feelings",
          "health",
          "people",
          "religion",
          "places",
          "animals",
          "industry",
          "computer",
          "food",
          "sports",
          "transportation",
          "travel",
          "buildings",
          "business",
          "music",
        ],
      },
      colors: {
        type: "string",
        description:
          "Comma-separated: grayscale, transparent, red, orange, yellow, green, turquoise, blue, lilac, pink, white, gray, black, brown",
      },
      editors_choice: { type: "boolean", default: false },
      safesearch: { type: "boolean", default: true },
      per_page: { type: "integer", default: 5, minimum: 3, maximum: 200 },
      page: { type: "integer", default: 1 },
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
  override idempotency_key_fields = [
    "query",
    "image_type",
    "orientation",
    "category",
    "page",
  ];
  override side_effects = ["writes image file to output_path", "calls Pixabay API"];
  override user_visible_verification = [
    "Check that downloaded image matches the intended scene",
  ];

  override estimateCost(_inputs: Record<string, unknown>): number {
    return 0.0; // Pixabay is free
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

    const url = new URL("https://pixabay.com/api/");
    url.searchParams.set("key", apiKey);
    url.searchParams.set("q", query);
    url.searchParams.set("per_page", String((inputs.per_page as number) ?? 5));
    url.searchParams.set("page", String((inputs.page as number) ?? 1));
    url.searchParams.set(
      "safesearch",
      String(inputs.safesearch ?? true).toLowerCase()
    );
    if (inputs.image_type && inputs.image_type !== "all")
      url.searchParams.set("image_type", inputs.image_type as string);
    if (inputs.orientation && inputs.orientation !== "all")
      url.searchParams.set("orientation", inputs.orientation as string);
    if (inputs.category) url.searchParams.set("category", inputs.category as string);
    if (inputs.colors) url.searchParams.set("colors", inputs.colors as string);
    if (inputs.editors_choice) url.searchParams.set("editors_choice", "true");

    let hit: PixabayHit;
    let data: { hits?: PixabayHit[]; total?: number };
    let outputPath: string;
    try {
      const searchResponse = await fetch(url);
      if (!searchResponse.ok) {
        const body = await searchResponse.text().catch(() => "");
        throw new Error(
          `HTTP ${searchResponse.status} ${searchResponse.statusText}: ${body}`
        );
      }
      data = (await searchResponse.json()) as { hits?: PixabayHit[]; total?: number };

      const hits = data.hits ?? [];
      if (hits.length === 0) {
        return toolResult({
          success: false,
          error: `No images found for query: ${query}`,
          data: { total_results: data.total ?? 0 },
        });
      }

      hit = hits[0]!;
      // largeImageURL is the best available at standard API tier (1280px)
      const imageUrl = hit.largeImageURL ?? hit.webformatURL;

      // Download immediately — Pixabay URLs contain embedded tokens that expire
      const imageResponse = await fetch(imageUrl as string);
      if (!imageResponse.ok) {
        throw new Error(
          `HTTP ${imageResponse.status} ${imageResponse.statusText} downloading ${imageUrl}`
        );
      }

      outputPath = (inputs.output_path as string) ?? `pixabay_${hit.id}.jpg`;
      fs.mkdirSync(path.dirname(outputPath) || ".", { recursive: true });
      fs.writeFileSync(outputPath, Buffer.from(await imageResponse.arrayBuffer()));
    } catch (e) {
      return toolResult({
        success: false,
        error: `Pixabay image search failed: ${(e as Error).message ?? e}`,
      });
    }

    return toolResult({
      success: true,
      data: {
        provider: "pixabay",
        image_id: hit.id,
        user: hit.user ?? "Unknown",
        tags: hit.tags ?? "",
        image_width: hit.imageWidth,
        image_height: hit.imageHeight,
        query,
        output: outputPath,
        total_results: data.total ?? 0,
        results_returned: (data.hits ?? []).length,
        license: "Pixabay Content License (free, no attribution required)",
        page_url: hit.pageURL ?? "",
      },
      artifacts: [outputPath],
      cost_usd: 0.0,
      duration_seconds: Math.round((Date.now() - start) / 10) / 100,
    });
  }
}
