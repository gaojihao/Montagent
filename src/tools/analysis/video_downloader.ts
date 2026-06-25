/**
 * Video downloader tool wrapping yt-dlp.
 *
 * TypeScript port of tools/analysis/video_downloader.py. Downloads video, audio,
 * or subtitles from YouTube, Shorts, Instagram Reels, TikTok, and 1000+ other
 * sites. Designed for reference video analysis — downloads at analysis quality
 * (720p), not production quality.
 *
 * Parity notes vs. Python:
 *  - The Python tool used the yt_dlp **Python library** (YoutubeDL + ydl_opts).
 *    Per the port directive, the TS port shells out to the **yt-dlp CLI**
 *    instead (dependencies=["cmd:yt-dlp"]), translating each ydl_opts dict into
 *    the equivalent CLI flags verbatim:
 *      quiet -> --quiet
 *      no_warnings -> --no-warnings
 *      skip_download -> --skip-download
 *      noplaylist -> --no-playlist
 *      format=F -> -f F
 *      merge_output_format=mp4 -> --merge-output-format mp4
 *      outtmpl=T -> -o T
 *      FFmpegExtractAudio{wav, quality 0} -> -x --audio-format wav --audio-quality 0
 *      writesubtitles -> --write-subs
 *      writeautomaticsub -> --write-auto-subs
 *      subtitleslangs=["en"] -> --sub-langs en
 *      subtitlesformat=srt -> --sub-format srt
 *    Metadata extraction (skip_download + extract_info) maps to
 *    --dump-single-json, and the same info fields are read from that JSON.
 *  - Platform detection, resolution map, duration safety limit, the separate
 *    ffmpeg audio extraction (pcm_s16le/16k/mono), _find_downloaded glob, and
 *    the result data/artifacts shapes are translated verbatim.
 *  - Python declared dependencies=["python:yt_dlp"] (a python: prefix dropped in
 *    the TS base). The directive replaces it with cmd:yt-dlp so the base
 *    getStatus() drives availability off the CLI binary.
 */
import fs from "node:fs";
import path from "node:path";
import {
  BaseTool,
  Determinism,
  ExecutionMode,
  ResourceProfile,
  ResumeSupport,
  ToolResult,
  ToolRuntime,
  ToolStability,
  ToolTier,
  toolResult,
} from "../base_tool.js";

export class VideoDownloader extends BaseTool {
  override name = "video_downloader";
  override version = "0.1.0";
  override tier = ToolTier.SOURCE;
  override capability = "source_ingest";
  override provider = "yt-dlp";
  override stability = ToolStability.PRODUCTION;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;
  override runtime = ToolRuntime.LOCAL;

  override dependencies = ["cmd:yt-dlp"];
  override install_instructions =
    "Install yt-dlp: pip install yt-dlp\n" +
    "For YouTube support, also install Deno (JS runtime): " +
    "https://deno.land/#installation\n" +
    "Without Deno, YouTube downloads may fail but other platforms still work.";
  override agent_skills = ["video-download"];

  override capabilities = [
    "download_video",
    "download_audio",
    "download_subtitles",
    "extract_metadata",
  ];

  override best_for = [
    "downloading reference video from URL",
    "extracting audio from online video",
    "downloading subtitles from YouTube",
    "getting video metadata without downloading",
  ];

  override not_good_for = [
    "downloading entire playlists",
    "downloading DRM-protected content",
  ];

  override input_schema = {
    type: "object",
    required: ["url", "output_dir"],
    properties: {
      url: { type: "string", description: "Video URL to download" },
      output_dir: { type: "string", description: "Directory for downloaded files" },
      format: {
        type: "string",
        enum: ["video", "audio_only", "subtitles_only", "metadata_only"],
        default: "video",
        description: "What to download",
      },
      max_resolution: {
        type: "string",
        enum: ["360p", "480p", "720p", "1080p"],
        default: "720p",
        description: "Maximum video resolution (for analysis, 720p is sufficient)",
      },
      max_duration_seconds: {
        type: "integer",
        default: 600,
        description: "Reject videos longer than this (safety limit)",
      },
    },
  };

  override output_schema = {
    type: "object",
    properties: {
      video_path: { type: ["string", "null"] },
      audio_path: { type: ["string", "null"] },
      subtitle_path: { type: ["string", "null"] },
      metadata: {
        type: "object",
        properties: {
          title: { type: "string" },
          duration: { type: "number" },
          uploader: { type: "string" },
          upload_date: { type: "string" },
          description: { type: "string" },
          view_count: { type: "integer" },
          like_count: { type: "integer" },
        },
      },
      platform: { type: "string" },
    },
  };

  override resource_profile: ResourceProfile = {
    cpu_cores: 1,
    ram_mb: 512,
    vram_mb: 0,
    disk_mb: 2000,
    network_required: true,
  };
  override idempotency_key_fields = ["url", "format", "max_resolution"];
  override side_effects = ["downloads media files to output_dir"];
  override resume_support: ResumeSupport = ResumeSupport.FROM_START;
  override user_visible_verification = [
    "Check downloaded file plays correctly",
    "Verify resolution matches requested max",
  ];

  // --- Resolution mapping ---
  static readonly RES_MAP: Record<string, number> = {
    "360p": 360,
    "480p": 480,
    "720p": 720,
    "1080p": 1080,
  };

  /** Detect platform from URL. */
  private _detectPlatform(url: string): string {
    const urlLower = url.toLowerCase();
    // Mirror Python precedence (note Python's `and` binds tighter than `or`):
    //   "youtube.com/shorts" in u or "youtu.be" in u and "/shorts" in u
    if (
      urlLower.includes("youtube.com/shorts") ||
      (urlLower.includes("youtu.be") && urlLower.includes("/shorts"))
    ) {
      return "shorts";
    }
    if (urlLower.includes("youtube.com") || urlLower.includes("youtu.be")) {
      return "youtube";
    }
    if (urlLower.includes("instagram.com")) {
      return "instagram";
    }
    if (urlLower.includes("tiktok.com")) {
      return "tiktok";
    }
    if (urlLower.includes("vimeo.com")) {
      return "vimeo";
    }
    if (urlLower.includes("twitter.com") || urlLower.includes("x.com")) {
      return "twitter";
    }
    return "other_url";
  }

  /** Extract metadata without downloading (yt-dlp --dump-single-json). */
  private async _extractMetadata(url: string): Promise<Record<string, unknown>> {
    // ydl_opts {quiet, no_warnings, skip_download} + extract_info(download=False)
    const cmd = [
      "yt-dlp",
      "--quiet",
      "--no-warnings",
      "--skip-download",
      "--dump-single-json",
      url,
    ];
    try {
      const result = await this.runCommand(cmd);
      const out = String(result.stdout ?? "");
      if (!out.trim()) {
        return { error: "No info extracted", title: "", duration: 0 };
      }
      const info = JSON.parse(out) as Record<string, unknown>;
      const width = Number(info.width ?? 0);
      const height = Number(info.height ?? 0);
      // Python: (info.get("description", "") or "")[:500] — falsy -> "".
      const description = String(info.description || "");
      return {
        title: info.title ?? "",
        duration: info.duration ?? 0,
        uploader: info.uploader ?? info.channel ?? "",
        upload_date: info.upload_date ?? "",
        description: description.slice(0, 500),
        view_count: info.view_count ?? 0,
        like_count: info.like_count ?? 0,
        resolution: `${width}x${height}`,
        fps: info.fps ?? 0,
      };
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      return {
        error: (err.stderr ?? err.message ?? String(e)).trim(),
        title: "",
        duration: 0,
      };
    }
  }

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const url = inputs.url as string;
    const outputDir = inputs.output_dir as string;
    const dlFormat = (inputs.format as string) ?? "video";
    const maxRes = (inputs.max_resolution as string) ?? "720p";
    const maxDuration = (inputs.max_duration_seconds as number) ?? 600;

    fs.mkdirSync(outputDir, { recursive: true });
    const platform = this._detectPlatform(url);
    const start = Date.now();

    // Step 1: Always get metadata first
    const metadata = await this._extractMetadata(url);

    // Check duration limit
    const duration = (metadata.duration as number) ?? 0;
    if (duration && duration > maxDuration) {
      return toolResult({
        success: false,
        error:
          `Video is ${duration}s, exceeds max_duration_seconds=${maxDuration}. ` +
          `Increase the limit or use a shorter video.`,
        data: { metadata, platform },
      });
    }

    if (dlFormat === "metadata_only") {
      return toolResult({
        success: true,
        data: {
          video_path: null,
          audio_path: null,
          subtitle_path: null,
          metadata,
          platform,
        },
        duration_seconds: round((Date.now() - start) / 1000, 2),
      });
    }

    let videoPath: string | null = null;
    let audioPath: string | null = null;
    let subtitlePath: string | null = null;

    try {
      if (dlFormat === "video") {
        [videoPath, audioPath] = await this._downloadVideo(url, outputDir, maxRes);
      } else if (dlFormat === "audio_only") {
        audioPath = await this._downloadAudio(url, outputDir);
      } else if (dlFormat === "subtitles_only") {
        subtitlePath = await this._downloadSubtitles(url, outputDir);
      }
    } catch (e) {
      const elapsed = (Date.now() - start) / 1000;
      return toolResult({
        success: false,
        error: `Download failed: ${(e as Error).message ?? e}`,
        data: { metadata, platform },
        duration_seconds: round(elapsed, 2),
      });
    }

    const elapsed = (Date.now() - start) / 1000;
    const artifacts = [videoPath, audioPath, subtitlePath].filter(
      (p): p is string => Boolean(p)
    );

    return toolResult({
      success: true,
      data: {
        video_path: videoPath,
        audio_path: audioPath,
        subtitle_path: subtitlePath,
        metadata,
        platform,
      },
      artifacts,
      duration_seconds: round(elapsed, 2),
    });
  }

  /** Download video + extract audio track. */
  private async _downloadVideo(
    url: string,
    outputDir: string,
    maxRes: string
  ): Promise<[string | null, string | null]> {
    const height = VideoDownloader.RES_MAP[maxRes] ?? 720;
    const videoOut = path.join(outputDir, "reference_video.%(ext)s");

    // ydl_opts: format / merge_output_format=mp4 / outtmpl / noplaylist / quiet / no_warnings
    const cmd = [
      "yt-dlp",
      "-f",
      `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]/best`,
      "--merge-output-format",
      "mp4",
      "-o",
      videoOut,
      "--no-playlist",
      "--quiet",
      "--no-warnings",
      url,
    ];
    await this.runCommand(cmd);

    // Find the downloaded video file
    const videoPath = this._findDownloaded(outputDir, "reference_video", [
      "mp4",
      "mkv",
      "webm",
    ]);

    // Extract audio separately for transcription
    let audioPath: string | null = null;
    if (videoPath) {
      const audioOut = path.join(outputDir, "reference_audio.wav");
      try {
        const audioCmd = [
          "ffmpeg",
          "-y",
          "-i",
          videoPath,
          "-vn",
          "-acodec",
          "pcm_s16le",
          "-ar",
          "16000",
          "-ac",
          "1",
          audioOut,
        ];
        await this.runCommand(audioCmd, { timeout: 120000 });
        if (fs.existsSync(audioOut)) {
          audioPath = audioOut;
        }
      } catch {
        // Audio extraction is optional
      }
    }

    return [videoPath, audioPath];
  }

  /** Download audio only. */
  private async _downloadAudio(
    url: string,
    outputDir: string
  ): Promise<string | null> {
    const audioOut = path.join(outputDir, "reference_audio.%(ext)s");
    // ydl_opts: format=bestaudio/best + FFmpegExtractAudio(wav, quality 0)
    const cmd = [
      "yt-dlp",
      "-f",
      "bestaudio/best",
      "-x",
      "--audio-format",
      "wav",
      "--audio-quality",
      "0",
      "-o",
      audioOut,
      "--no-playlist",
      "--quiet",
      "--no-warnings",
      url,
    ];
    await this.runCommand(cmd);
    return this._findDownloaded(outputDir, "reference_audio", [
      "wav",
      "mp3",
      "m4a",
      "opus",
    ]);
  }

  /** Download subtitles only. */
  private async _downloadSubtitles(
    url: string,
    outputDir: string
  ): Promise<string | null> {
    const subOut = path.join(outputDir, "reference_subs.%(ext)s");
    // ydl_opts: writesubtitles / writeautomaticsub / subtitleslangs=["en"] /
    //           subtitlesformat=srt / skip_download / noplaylist / quiet / no_warnings
    const cmd = [
      "yt-dlp",
      "--write-subs",
      "--write-auto-subs",
      "--sub-langs",
      "en",
      "--sub-format",
      "srt",
      "--skip-download",
      "-o",
      subOut,
      "--no-playlist",
      "--quiet",
      "--no-warnings",
      url,
    ];
    try {
      await this.runCommand(cmd);
    } catch {
      // Mirror Python: subtitle download failure is swallowed.
    }
    return this._findDownloaded(outputDir, "reference_subs", ["srt", "vtt", "ass"]);
  }

  /** Find a downloaded file by prefix and possible extensions. */
  private _findDownloaded(
    outputDir: string,
    prefix: string,
    extensions: string[]
  ): string | null {
    let files: string[];
    try {
      files = fs.readdirSync(outputDir);
    } catch {
      return null;
    }
    for (const ext of extensions) {
      const suffix = `.${ext}`;
      // Python: list(output_dir.glob(f"{prefix}*.{ext}"))[0]
      const candidates = files
        .filter((f) => f.startsWith(prefix) && f.endsWith(suffix))
        .sort();
      if (candidates.length > 0) {
        return path.join(outputDir, candidates[0]!);
      }
    }
    return null;
  }
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
