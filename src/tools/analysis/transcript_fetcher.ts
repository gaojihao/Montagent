/**
 * YouTube transcript fetcher (TS port of tools/analysis/transcript_fetcher.py).
 *
 * The Python wrapped the `youtube-transcript-api` package. Per the no-Python-runtime
 * rule, the TS port reimplements it with `fetch`: load the watch page, extract the
 * caption track baseUrl from ytInitialPlayerResponse, fetch the timedtext XML, and
 * parse it into {text, start, duration} segments. No API key, no Python dependency.
 */
import {
  BaseTool,
  Determinism,
  ExecutionMode,
  type ResourceProfile,
  type ToolResult,
  ToolRuntime,
  ToolStability,
  ToolTier,
  toolResult,
} from "../base_tool.js";

export class TranscriptFetcher extends BaseTool {
  override name = "transcript_fetcher";
  override version = "0.1.0";
  override tier = ToolTier.ANALYZE;
  override capability = "analysis";
  override provider = "youtube-transcript-api";
  override stability = ToolStability.PRODUCTION;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;
  override runtime = ToolRuntime.LOCAL;

  override dependencies: string[] = []; // pure HTTP in the TS port (no youtube_transcript_api)
  override install_instructions =
    "No setup needed — fetches YouTube captions over HTTP. Requires network access.";
  override agent_skills: string[] = [];

  override capabilities = ["fetch_transcript", "list_transcripts"];
  override best_for = [
    "fast YouTube transcript extraction",
    "caption-based analysis without video download",
    "getting timestamped text from YouTube videos",
  ];
  override not_good_for = [
    "non-YouTube platforms (Instagram, TikTok)",
    "videos without any captions",
    "speaker diarization (use transcriber tool instead)",
  ];

  override input_schema = {
    type: "object",
    required: ["url_or_video_id"],
    properties: {
      url_or_video_id: { type: "string", description: "YouTube URL or video ID" },
      languages: {
        type: "array",
        items: { type: "string" },
        default: ["en"],
        description: "Preferred languages in priority order",
      },
      include_auto_generated: {
        type: "boolean",
        default: true,
        description: "Whether to include auto-generated captions",
      },
    },
  };

  override resource_profile: ResourceProfile = {
    cpu_cores: 1,
    ram_mb: 256,
    vram_mb: 0,
    disk_mb: 10,
    network_required: true,
  };
  override idempotency_key_fields = ["url_or_video_id", "languages"];
  override side_effects = [];
  override fallback = "transcriber";
  override user_visible_verification = ["Spot-check transcript accuracy against video audio"];

  private extractVideoId(urlOrId: string): string {
    if (/^[A-Za-z0-9_-]{11}$/.test(urlOrId)) return urlOrId;
    const m = urlOrId.match(
      /(?:youtube\.com\/watch\?.*v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/
    );
    if (m) return m[1]!;
    return urlOrId.trim();
  }

  private decodeXmlEntities(s: string): string {
    return s
      .replace(/&amp;/g, "&")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)));
  }

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const videoId = this.extractVideoId(inputs.url_or_video_id as string);
    const languages = (inputs.languages as string[]) ?? ["en"];
    const start = Date.now();

    try {
      // 1. Load the watch page to find caption tracks.
      const watch = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
        headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "en-US,en;q=0.9" },
      });
      const html = await watch.text();
      const m = html.match(/"captionTracks":(\[.*?\])/);
      if (!m) {
        return toolResult({
          success: false,
          error:
            `No captions available for video ${videoId}. This video may not have captions enabled. ` +
            "Fallback: download the video and use the transcriber tool with Whisper for local transcription.",
          data: { video_id: videoId, fallback_suggested: "transcriber" },
          duration_seconds: Math.round((Date.now() - start) / 10) / 100,
        });
      }
      const tracks = JSON.parse(m[1]!) as Array<{
        baseUrl: string;
        languageCode: string;
        kind?: string;
        name?: { simpleText?: string };
      }>;

      // 2. Pick a track by preferred language, else the first.
      let track = tracks.find((t) => languages.includes(t.languageCode));
      if (!track) track = tracks[0];
      if (!track) {
        return toolResult({ success: false, error: `No caption tracks for ${videoId}`, data: { video_id: videoId } });
      }
      const isAuto = track.kind === "asr";

      // 3. Fetch the timedtext XML and parse <text start=".." dur=".."> nodes.
      const ttResp = await fetch(this.decodeXmlEntities(track.baseUrl), {
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      const xml = await ttResp.text();
      const segments: Array<{ text: string; start: number; duration: number }> = [];
      const parts: string[] = [];
      const re = /<text start="([\d.]+)"(?: dur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/g;
      let node: RegExpExecArray | null;
      while ((node = re.exec(xml)) !== null) {
        const text = this.decodeXmlEntities(node[3]!.replace(/<[^>]+>/g, "")).trim();
        if (!text) continue;
        segments.push({
          text,
          start: Math.round(parseFloat(node[1]!) * 1000) / 1000,
          duration: Math.round(parseFloat(node[2] ?? "0") * 1000) / 1000,
        });
        parts.push(text);
      }

      if (segments.length === 0) {
        return toolResult({
          success: false,
          error: `No captions parsed for video ${videoId}.`,
          data: { video_id: videoId, fallback_suggested: "transcriber" },
          duration_seconds: Math.round((Date.now() - start) / 10) / 100,
        });
      }

      const fullText = parts.join(" ");
      return toolResult({
        success: true,
        data: {
          transcript: segments,
          full_text: fullText,
          language: track.languageCode,
          is_auto_generated: isAuto,
          word_count: fullText.split(/\s+/).filter(Boolean).length,
          source: "youtube_captions",
          video_id: videoId,
          segment_count: segments.length,
        },
        duration_seconds: Math.round((Date.now() - start) / 10) / 100,
      });
    } catch (e) {
      return toolResult({
        success: false,
        error: `Transcript fetch failed: ${(e as Error).message}`,
        data: { video_id: videoId },
        duration_seconds: Math.round((Date.now() - start) / 10) / 100,
      });
    }
  }
}
