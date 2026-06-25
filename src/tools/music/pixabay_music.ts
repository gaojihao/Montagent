/**
 * Music search and download from Pixabay Music (free, no API key).
 *
 * TypeScript port of tools/audio/pixabay_music.py. Scrapes Pixabay's music
 * section to find and download royalty-free background music tracks. No API key
 * required — uses web scraping.
 *
 * Stability: EXPERIMENTAL — Pixabay's HTML structure may change without notice,
 * which could break the scraper. Use freesound_music or music_gen as more
 * stable alternatives.
 *
 * Parity notes vs. Python:
 *  - get_status() is always AVAILABLE (no API key) -> dependencies = [].
 *  - urllib + cookiejar session is reproduced with fetch: the search-page
 *    response's set-cookie headers are captured and forwarded as a Cookie header
 *    on the bootstrap request (matching urllib's HTTPCookieProcessor session).
 *  - Slug build (re.sub(\s+ -> "-") on a lowercased/trimmed query, then
 *    urllib.parse.quote(..., safe="-")) is reproduced exactly, including the
 *    quote() unreserved-char set (letters, digits, "_.-~") plus the safe "-".
 *  - Bootstrap-URL regex, page.results mapping, the brute-force CDN-MP3 HTML
 *    fallback, duration filtering, the unfiltered fallback, and the [:60] safe
 *    title truncation all match verbatim. Non-2xx on download -> throw.
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

interface PixabayTrack {
  title: string;
  audio_url: string;
  duration: number | null;
  artist: string;
  rating?: unknown;
  download_count?: unknown;
  pixabay_id?: unknown;
}

export class PixabayMusic extends BaseTool {
  override name = "pixabay_music";
  override version = "0.1.0";
  override tier = ToolTier.SOURCE;
  override capability = "music_search";
  override provider = "pixabay_music";
  override stability = ToolStability.EXPERIMENTAL;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;
  override runtime = ToolRuntime.API;

  override dependencies = []; // no API key needed — web scraping
  override install_instructions =
    "No setup required. Pixabay Music is free and needs no API key.\n" +
    "Note: This tool scrapes the Pixabay website. If it breaks, the\n" +
    "site's HTML structure may have changed. Use freesound_music as fallback.";

  override agent_skills = ["music"];

  override capabilities = ["search_music", "download_music", "stock_music"];
  override supports = {
    duration_filter: true,
    free_commercial_use: true,
    no_api_key: true,
  };
  override best_for = [
    "quick background music with zero setup (no API key)",
    "royalty-free music for any commercial project",
    "high-quality produced tracks (not raw samples)",
  ];
  override not_good_for = [
    "reliable long-term automation (scraping may break)",
    "precise metadata filtering",
    "offline use",
  ];

  override fallback_tools = ["freesound_music", "music_gen"];

  override input_schema = {
    type: "object",
    required: ["query"],
    properties: {
      query: {
        type: "string",
        description:
          "Search query for music (e.g., 'upbeat corporate background')",
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
    retryable_errors: ["timeout"],
  };
  override idempotency_key_fields = ["query", "min_duration", "max_duration"];
  override side_effects = [
    "writes audio file to output_path",
    "scrapes Pixabay website",
  ];
  override user_visible_verification = [
    "Listen to downloaded track for mood and quality",
  ];

  static readonly _USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/131.0.0.0 Safari/537.36";

  static readonly _BROWSER_HEADERS: Record<string, string> = {
    Accept:
      "text/html,application/xhtml+xml,application/xml;" +
      "q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Sec-Ch-Ua": '"Chromium";v="131", "Not_A Brand";v="24"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
  };

  override estimateCost(_inputs: Record<string, unknown>): number {
    return 0.0; // Pixabay Music is free
  }

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const start = Date.now();

    let track: PixabayTrack;
    let tracks: PixabayTrack[];
    let filtered: PixabayTrack[];
    let outputPath: string;
    try {
      // Step 1: Search Pixabay Music
      tracks = await this.search(inputs);
      if (tracks.length === 0) {
        return toolResult({
          success: false,
          error: `No music found on Pixabay for query: ${inputs.query as string}`,
          data: { query: inputs.query },
          duration_seconds: Math.round((Date.now() - start) / 10) / 100,
        });
      }

      // Step 2: Filter by duration
      const minDur = (inputs.min_duration as number) ?? 30;
      const maxDur = (inputs.max_duration as number) ?? 120;
      filtered = tracks.filter(
        (t) =>
          t.duration !== null &&
          t.duration !== undefined &&
          minDur <= t.duration &&
          t.duration <= maxDur
      );

      // Fall back to unfiltered if no matches within duration range
      if (filtered.length === 0) {
        filtered = tracks;
      }

      // Step 3: Pick the first matching track
      track = filtered[0] as PixabayTrack;

      // Step 4: Download the audio
      outputPath = await this.download(track, inputs);
    } catch (e) {
      return toolResult({
        success: false,
        error: `Pixabay music search failed: ${(e as Error).message ?? e}`,
        duration_seconds: Math.round((Date.now() - start) / 10) / 100,
      });
    }

    return toolResult({
      success: true,
      data: {
        provider: "pixabay_music",
        track_title: track.title ?? "Unknown",
        artist: track.artist ?? "Unknown",
        duration_seconds: track.duration,
        query: inputs.query,
        output: outputPath,
        format: "mp3",
        license:
          "Pixabay Content License (free, no attribution required)",
        results_found: tracks.length,
        results_after_filter: filtered.length,
      },
      artifacts: [outputPath],
      cost_usd: 0.0,
      duration_seconds: Math.round((Date.now() - start) / 10) / 100,
    });
  }

  /**
   * Search Pixabay Music via the bootstrap JSON API.
   *
   * Pixabay's music page loads track data from a bootstrap JSON endpoint whose
   * URL is embedded in the HTML. We:
   * 1. Fetch the search page HTML (which sets session cookies).
   * 2. Extract the __BOOTSTRAP_URL__ from an inline script tag.
   * 3. Fetch the bootstrap JSON (same session) to get structured track data
   *    including direct CDN MP3 URLs, durations, and metadata.
   * 4. Fall back to HTML-scraping if bootstrap extraction fails.
   */
  private async search(
    inputs: Record<string, unknown>
  ): Promise<PixabayTrack[]> {
    const query = inputs.query as string;
    let slug = query.trim().toLowerCase().replace(/\s+/g, "-");
    slug = quoteSafeDash(slug);
    const searchUrl = `https://pixabay.com/music/search/${slug}/`;

    // Step 1: Fetch search page HTML (sets cookies)
    const response = await fetch(searchUrl, {
      method: "GET",
      headers: {
        "User-Agent": PixabayMusic._USER_AGENT,
        ...PixabayMusic._BROWSER_HEADERS,
      },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${body}`);
    }
    const html = await response.text();

    // Capture session cookies for the bootstrap request (urllib cookiejar parity).
    const cookieHeader = extractCookieHeader(response);

    // Step 2: Extract bootstrap URL and fetch track data
    const tracks = await this.parseBootstrap(html, searchUrl, cookieHeader);
    if (tracks.length > 0) {
      return tracks;
    }

    // Step 3: Fallback — scrape HTML directly (legacy strategies)
    return this.parseTracksHtml(html);
  }

  /** Extract tracks from Pixabay's bootstrap JSON endpoint. */
  private async parseBootstrap(
    html: string,
    referer: string,
    cookieHeader: string | null
  ): Promise<PixabayTrack[]> {
    const match = html.match(
      /window\.__BOOTSTRAP_URL__\s*=\s*["']([^"']+)["']/
    );
    if (!match) {
      return [];
    }

    const bootstrapPath = match[1];
    if (!bootstrapPath || bootstrapPath === "") {
      return [];
    }

    const bootstrapUrl = `https://pixabay.com${bootstrapPath}`;

    const headers: Record<string, string> = {
      "User-Agent": PixabayMusic._USER_AGENT,
      Accept: "application/json, text/plain, */*",
      Referer: referer,
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
    };
    if (cookieHeader) headers.Cookie = cookieHeader;

    let data: Record<string, unknown>;
    try {
      const response = await fetch(bootstrapUrl, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        return [];
      }
      data = (await response.json()) as Record<string, unknown>;
    } catch {
      return [];
    }

    const page = (data.page as Record<string, unknown> | undefined) ?? {};
    const results = (page.results as Array<Record<string, unknown>>) ?? [];
    const tracks: PixabayTrack[] = [];

    for (const item of results) {
      const sources = (item.sources as Record<string, unknown>) ?? {};
      const audioUrl = sources.src as string | undefined;
      if (!audioUrl) {
        continue;
      }

      const user = (item.user as Record<string, unknown>) ?? {};
      tracks.push({
        title:
          (item.name as string | undefined) ||
          (sources.filename as string | undefined) ||
          "Unknown",
        audio_url: audioUrl,
        duration: (item.duration as number | null | undefined) ?? null,
        artist: (user.username as string | undefined) ?? "Unknown",
        rating: item.rating,
        download_count: item.downloadCount,
        pixabay_id: item.id,
      });
    }

    return tracks;
  }

  /**
   * Fallback: extract track info from HTML when bootstrap fails.
   * Tries a brute-force scan for CDN MP3 URLs in the page source.
   */
  private parseTracksHtml(html: string): PixabayTrack[] {
    const tracks: PixabayTrack[] = [];

    const mp3Regex =
      /(https?:\/\/cdn\.pixabay\.com\/audio\/[^\s"'<>]+\.mp3[^\s"'<>]*)/g;
    const seen = new Set<string>();
    for (const m of html.matchAll(mp3Regex)) {
      const url = m[1] as string;
      if (!seen.has(url)) {
        seen.add(url);
        tracks.push({
          title: "Unknown",
          audio_url: url,
          duration: null,
          artist: "Unknown",
        });
      }
    }

    return tracks;
  }

  /** Download an MP3 track to the output path. */
  private async download(
    track: PixabayTrack,
    inputs: Record<string, unknown>
  ): Promise<string> {
    let audioUrl = track.audio_url;
    if (!audioUrl) {
      throw new Error("No audio URL found for the selected track.");
    }

    // Ensure URL is absolute
    if (audioUrl.startsWith("//")) {
      audioUrl = "https:" + audioUrl;
    } else if (audioUrl.startsWith("/")) {
      audioUrl = "https://pixabay.com" + audioUrl;
    }

    // Build output path
    const trackTitle = track.title ?? "pixabay_music";
    const safeTitle = sanitizeFilename(trackTitle);
    const defaultFilename = `pixabay_music_${safeTitle.slice(0, 60)}.mp3`;
    const outputPath = path.resolve(
      (inputs.output_path as string) ?? defaultFilename
    );
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const response = await fetch(audioUrl, {
      method: "GET",
      headers: {
        "User-Agent": PixabayMusic._USER_AGENT,
        Referer: "https://pixabay.com/music/",
      },
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
 *   "".join(c if c.isalnum() or c in "._- " else "_" for c in title)
 * Unicode-aware (Python str.isalnum()): keeps letters/numbers plus "._- " and
 * space, replacing everything else with "_".
 */
function sanitizeFilename(name: string): string {
  return name.replace(/[^\p{L}\p{N}._\- ]/gu, "_");
}

/**
 * Equivalent of urllib.parse.quote(s, safe="-").
 * Percent-encodes every byte except urllib's always-safe unreserved set
 * (ASCII letters, digits, "_.-~") and the explicitly-safe "-". Encoding is
 * UTF-8, uppercase hex — matching urllib.
 */
function quoteSafeDash(s: string): string {
  const safe = /[A-Za-z0-9_.\-~]/;
  const bytes = Buffer.from(s, "utf-8");
  let out = "";
  for (const b of bytes) {
    const ch = String.fromCharCode(b);
    if (safe.test(ch)) {
      out += ch;
    } else {
      out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return out;
}

/**
 * Collapse a fetch Response's Set-Cookie header(s) into a single Cookie header
 * value (name=value pairs joined by "; "), mimicking what urllib's cookiejar
 * would replay on the follow-up same-origin request.
 */
function extractCookieHeader(response: Response): string | null {
  // Node's undici exposes getSetCookie() for multiple Set-Cookie headers.
  const getSetCookie = (
    response.headers as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie;
  const raw: string[] =
    typeof getSetCookie === "function"
      ? getSetCookie.call(response.headers)
      : (() => {
          const single = response.headers.get("set-cookie");
          return single ? [single] : [];
        })();

  const pairs: string[] = [];
  for (const cookie of raw) {
    const first = cookie.split(";", 1)[0]?.trim();
    if (first && first.includes("=")) {
      pairs.push(first);
    }
  }
  return pairs.length > 0 ? pairs.join("; ") : null;
}
