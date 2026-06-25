/**
 * Video analyzer tool — comprehensive reference video analysis. provider=multi.
 *
 * TypeScript port of tools/analysis/video_analyzer.py. Orchestrates multiple
 * analysis tools to produce a VideoAnalysisBrief from a video URL or local
 * file: yt-dlp (via video_downloader) for download, PySceneDetect/FFmpeg (via
 * scene_detect) for scene detection, FFmpeg (via frame_sampler) for keyframe
 * extraction, and ffmpeg/ebur128 (via audio_energy) for audio energy. The
 * agent's own vision model interprets the extracted keyframes; this tool
 * provides the structured data.
 *
 * Parity notes vs. Python:
 *  - The fully-ported analysis sub-tools (video_downloader, scene_detect,
 *    frame_sampler, audio_energy) are imported directly and orchestrated
 *    exactly as the Python does, preserving the VideoAnalysisBrief shape,
 *    pacing/complexity/pipeline heuristics, keyframe-timestamp computation,
 *    and the steps_completed/steps_failed bookkeeping verbatim.
 *
 *  - TRANSCRIPTION DEPENDENCY (documented deviation): the Python transcript
 *    steps depend on `transcriber` (faster-whisper) and `transcript_fetcher`
 *    (youtube-transcript-api), which are NOT yet ported (a later wave). They
 *    are imported defensively via dynamic import() inside try/catch; if the
 *    modules are absent (the current state), the transcript steps are recorded
 *    in steps_failed and analysis continues — matching the Python behavior when
 *    those optional libs are not installed. When the modules land in a later
 *    wave, this orchestration will pick them up with no further changes.
 *
 *  - MOTION CLASSIFICATION (documented deviation): Python's
 *    _classify_scene_motion uses OpenCV (cv2) dense optical flow + numpy, a
 *    Python-only CV stack with no clean Node port. The Python code itself
 *    degrades to [{"motion_type": "unknown", "flow_variance": -1}] * len(scenes)
 *    when cv2 is unavailable; the TS port returns exactly that degraded result
 *    (cv2 never exists in Node), and the caller still records
 *    "motion_classification" as completed — identical to Python in a cv2-free
 *    environment. The flow-classification constants/thresholds are documented
 *    below for fidelity.
 *
 *  - ffprobe arg arrays translated verbatim; rounding matches Python.
 */
import fs from "node:fs";
import path from "node:path";
import {
  BaseTool,
  Determinism,
  ExecutionMode,
  ResourceProfile,
  ToolResult,
  ToolRuntime,
  ToolStability,
  ToolTier,
  toolResult,
} from "../base_tool.js";
import { VideoDownloader } from "./video_downloader.js";
import { SceneDetect } from "./scene_detect.js";
import { FrameSampler } from "./frame_sampler.js";
import { AudioEnergy } from "./audio_energy.js";

export class VideoAnalyzer extends BaseTool {
  override name = "video_analyzer";
  override version = "0.1.0";
  override tier = ToolTier.ANALYZE;
  override capability = "analysis";
  override provider = "multi";
  override stability = ToolStability.BETA;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;
  override runtime = ToolRuntime.LOCAL;

  override dependencies = ["cmd:ffmpeg"];
  override install_instructions =
    "Core: FFmpeg is required (https://ffmpeg.org/download.html)\n" +
    "For URL downloads: pip install yt-dlp\n" +
    "For YouTube transcripts: pip install youtube-transcript-api\n" +
    "For local transcription: pip install faster-whisper\n" +
    "For scene detection: pip install scenedetect[opencv]\n" +
    "All dependencies are free and local — no API keys needed.";
  override agent_skills = ["video-understand", "ffmpeg"];

  override capabilities = [
    "analyze_reference_video",
    "extract_structure",
    "extract_style",
    "extract_transcript",
  ];

  override best_for = [
    "comprehensive video analysis",
    "reference video understanding",
    "style extraction from example video",
    "understanding video structure and pacing",
  ];

  override not_good_for = [
    "editing or modifying video",
    "generating new video content",
  ];

  override input_schema = {
    type: "object",
    required: ["source"],
    properties: {
      source: {
        type: "string",
        description: "Video file path or URL (YouTube, Shorts, Instagram, TikTok)",
      },
      analysis_depth: {
        type: "string",
        enum: ["transcript_only", "standard", "deep"],
        default: "standard",
        description:
          "transcript_only: transcript + metadata only. " +
          "standard: + scene detection + keyframes + audio energy. " +
          "deep: + intra-scene sampling + detailed style extraction.",
      },
      max_keyframes: {
        type: "integer",
        default: 20,
        minimum: 1,
        maximum: 50,
        description: "Maximum keyframes to extract",
      },
      output_dir: {
        type: "string",
        description: "Directory for analysis outputs (default: auto-generated)",
      },
    },
  };

  override output_schema = {
    type: "object",
    description:
      "VideoAnalysisBrief artifact — see schemas/artifacts/video_analysis_brief.schema.json",
  };

  override resource_profile: ResourceProfile = {
    cpu_cores: 2,
    ram_mb: 2048,
    vram_mb: 0,
    disk_mb: 3000,
    network_required: false, // Only needed for URL sources
  };
  override idempotency_key_fields = ["source", "analysis_depth"];
  override side_effects = [
    "downloads video to output_dir (if URL)",
    "writes keyframe images to output_dir/keyframes/",
    "writes analysis JSON to output_dir/video_analysis_brief.json",
  ];
  override fallback_tools = [];
  override user_visible_verification = [
    "Review keyframe images for representative coverage",
    "Check transcript accuracy against video",
    "Verify scene boundaries look correct",
  ];

  /** Check if source is a URL vs local file. */
  private _isUrl(source: string): boolean {
    return (
      source.startsWith("http://") ||
      source.startsWith("https://") ||
      source.startsWith("www.")
    );
  }

  /** Detect platform from URL. */
  private _detectPlatform(source: string): string {
    if (!this._isUrl(source)) {
      return "local_file";
    }
    const s = source.toLowerCase();
    if (s.includes("youtube.com/shorts")) return "shorts";
    if (s.includes("youtube.com") || s.includes("youtu.be")) return "youtube";
    if (s.includes("instagram.com")) return "instagram";
    if (s.includes("tiktok.com")) return "tiktok";
    return "other_url";
  }

  private _isYoutube(platform: string): boolean {
    return platform === "youtube" || platform === "shorts";
  }

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const source = inputs.source as string;
    const depth = (inputs.analysis_depth as string) ?? "standard";
    const maxKeyframes = (inputs.max_keyframes as number) ?? 20;

    // Setup output directory
    let outputDir: string;
    if (inputs.output_dir) {
      outputDir = inputs.output_dir as string;
    } else {
      outputDir = path.join(
        "projects",
        "_analysis",
        `analysis_${Math.trunc(Date.now() / 1000)}`
      );
    }
    fs.mkdirSync(outputDir, { recursive: true });

    const platform = this._detectPlatform(source);
    const isUrl = this._isUrl(source);
    const start = Date.now();

    // Initialize brief structure
    const brief: Record<string, any> = {
      version: "1.0",
      source: {
        type: platform,
        duration_seconds: 0,
      },
      content_analysis: {
        summary: "",
        topics: [],
        target_audience: "general",
      },
      structure_analysis: {
        total_scenes: 0,
        scenes: [],
        pacing_profile: {},
      },
    };

    if (isUrl) {
      brief.source.url = source;
    } else {
      brief.source.local_path = source;
    }

    // Track what succeeded and what failed
    const stepsCompleted: string[] = [];
    const stepsFailed: string[] = [];

    // ─── STEP 1: Get metadata + download (if URL) ───
    let videoPath: string | null = null;
    let audioPath: string | null = null;
    let metadata: Record<string, any> = {};

    if (isUrl) {
      try {
        const downloader = new VideoDownloader();

        let dlResult: ToolResult;
        if (depth === "transcript_only" && this._isYoutube(platform)) {
          // Only get metadata, skip video download
          dlResult = await downloader.execute({
            url: source,
            output_dir: outputDir,
            format: "metadata_only",
          });
        } else {
          dlResult = await downloader.execute({
            url: source,
            output_dir: outputDir,
            format: "video",
            max_resolution: "720p",
          });
        }

        if (dlResult.success) {
          metadata = (dlResult.data?.metadata as Record<string, any>) ?? {};
          videoPath = (dlResult.data?.video_path as string | null) ?? null;
          audioPath = (dlResult.data?.audio_path as string | null) ?? null;
          brief.source.title = metadata.title ?? "";
          brief.source.duration_seconds = metadata.duration ?? 0;
          brief.source.resolution = metadata.resolution ?? "";
          brief.source.platform_metadata = {
            uploader: metadata.uploader ?? "",
            upload_date: metadata.upload_date ?? "",
            view_count: metadata.view_count ?? 0,
            like_count: metadata.like_count ?? 0,
            description: metadata.description ?? "",
          };
          stepsCompleted.push("metadata");
          if (videoPath) {
            stepsCompleted.push("download");
          }
        } else {
          stepsFailed.push(`download: ${dlResult.error}`);
        }
      } catch (e) {
        stepsFailed.push(`download: ${(e as Error).message ?? e}`);
      }
    } else {
      // Local file
      if (!fs.existsSync(source)) {
        return toolResult({
          success: false,
          error: `Local file not found: ${source}`,
        });
      }
      videoPath = source;
      // Get duration via ffprobe
      try {
        const duration = await this._getDuration(source);
        brief.source.duration_seconds = duration;
        brief.source.title = stem(source);
        stepsCompleted.push("metadata");
      } catch (e) {
        stepsFailed.push(`metadata: ${(e as Error).message ?? e}`);
      }
    }

    // ─── STEP 2: Get transcript ───
    let transcriptData: Record<string, any> | null = null;

    // Try youtube-transcript-api first (instant, for YouTube).
    // DEVIATION: transcript_fetcher / youtube_transcript_api are not ported yet
    // (later wave) — imported defensively; absence is recorded and skipped.
    if (this._isYoutube(platform)) {
      try {
        const ytApiMod = await this._tryImport("youtube_transcript_api");
        const fetcherMod = await this._tryImport("./transcript_fetcher.js");
        if (!ytApiMod || !fetcherMod) {
          throw new Error(
            "transcript_fetcher / youtube_transcript_api not available in the TypeScript port"
          );
        }
        const { YouTubeTranscriptApi } = ytApiMod as any;
        const TranscriptFetcher = (fetcherMod as any).TranscriptFetcher;
        const fetcher = new TranscriptFetcher();

        // Auto-detect available languages instead of hardcoding "en"
        let languagesToTry = ["en"];
        try {
          const ytt = new YouTubeTranscriptApi();
          const available = ytt.list(fetcher._extractVideoId(source));
          const langCodes: string[] = [];
          for (const t of available) {
            const code = t.language_code !== undefined ? t.language_code : String(t);
            if (!langCodes.includes(code)) {
              langCodes.push(code);
            }
          }
          if (langCodes.length > 0) {
            languagesToTry = langCodes;
          }
        } catch {
          // Fall through to default ["en"]
        }

        const tfResult: ToolResult = await fetcher.execute({
          url_or_video_id: source,
          languages: languagesToTry,
          include_auto_generated: true,
        });
        if (tfResult.success) {
          transcriptData = tfResult.data as Record<string, any>;
          brief.narration_transcript = {
            full_text: transcriptData.full_text ?? "",
            segments: transcriptData.transcript ?? [],
            language: transcriptData.language ?? "en",
            word_count: transcriptData.word_count ?? 0,
          };
          stepsCompleted.push("transcript_youtube");
        }
      } catch (e) {
        stepsFailed.push(`transcript_youtube: ${(e as Error).message ?? e}`);
      }
    }

    // Fallback: If transcript failed and we don't have audio yet,
    // download the video to get audio for Whisper transcription
    if (
      transcriptData === null &&
      audioPath === null &&
      videoPath === null &&
      isUrl
    ) {
      try {
        const downloader = new VideoDownloader();
        const dlResult = await downloader.execute({
          url: source,
          output_dir: outputDir,
          format: "video",
          max_resolution: "720p",
        });
        if (dlResult.success) {
          videoPath = (dlResult.data?.video_path as string | null) ?? null;
          audioPath = (dlResult.data?.audio_path as string | null) ?? null;
          if (videoPath) {
            stepsCompleted.push("download_for_whisper");
          }
          // Also update metadata if we didn't have it
          if (Object.keys(metadata).length === 0) {
            metadata = (dlResult.data?.metadata as Record<string, any>) ?? {};
            brief.source.title = metadata.title ?? "";
            brief.source.duration_seconds = metadata.duration ?? 0;
          }
        }
      } catch (e) {
        stepsFailed.push(`download_for_whisper: ${(e as Error).message ?? e}`);
      }
    }

    // Fallback: Whisper transcription on audio.
    // DEVIATION: transcriber (faster-whisper) is not ported yet (later wave) —
    // imported defensively; absence is recorded and skipped.
    if (transcriptData === null && audioPath) {
      try {
        const transcriberMod = await this._tryImport("./transcriber.js");
        if (!transcriberMod) {
          throw new Error(
            "transcriber (faster-whisper) not available in the TypeScript port"
          );
        }
        const Transcriber = (transcriberMod as any).Transcriber;
        const transcriber = new Transcriber();
        // Let Whisper auto-detect language instead of assuming English
        const trInputs: Record<string, unknown> = {
          input_path: audioPath,
          model_size: "base",
          output_dir: outputDir,
        };
        // Only set language if we know it from transcript attempt
        const detectedLang = brief.narration_transcript?.language;
        if (detectedLang && detectedLang !== "en") {
          trInputs.language = detectedLang;
        }
        // else: let Whisper auto-detect

        const trResult: ToolResult = await transcriber.execute(trInputs);
        if (trResult.success) {
          const segments = (trResult.data?.segments as Array<Record<string, any>>) ?? [];
          const fullText = segments.map((s) => s.text ?? "").join(" ");
          brief.narration_transcript = {
            full_text: fullText,
            segments: segments.map((s) => ({
              start: s.start ?? 0,
              end: s.end ?? 0,
              text: s.text ?? "",
            })),
            language: trResult.data?.language ?? "en",
            word_count: fullText.split(/\s+/).filter(Boolean).length,
          };
          transcriptData = brief.narration_transcript;
          stepsCompleted.push("transcript_whisper");
        }
      } catch (e) {
        stepsFailed.push(`transcript_whisper: ${(e as Error).message ?? e}`);
      }
    }

    // For transcript_only depth, we're done
    if (depth === "transcript_only") {
      brief._analysis_meta = {
        depth,
        steps_completed: stepsCompleted,
        steps_failed: stepsFailed,
        duration_seconds: round((Date.now() - start) / 1000, 2),
      };
      this._saveBrief(brief, outputDir);
      return toolResult({
        success: true,
        data: brief,
        artifacts: [path.join(outputDir, "video_analysis_brief.json")],
        duration_seconds: round((Date.now() - start) / 1000, 2),
      });
    }

    // ─── STEP 3: Scene detection (standard + deep) ───
    let scenes: Array<Record<string, any>> = [];
    if (videoPath) {
      try {
        const detector = new SceneDetect();
        const sdResult = await detector.execute({
          input_path: videoPath,
          method: "content",
          min_scene_length_seconds: 0.5,
          output_path: path.join(outputDir, "scenes.json"),
        });
        if (sdResult.success) {
          scenes = (sdResult.data?.scenes as Array<Record<string, any>>) ?? [];
          stepsCompleted.push("scene_detect");
        }
      } catch (e) {
        stepsFailed.push(`scene_detect: ${(e as Error).message ?? e}`);
      }
    }

    // Build scene list for the brief
    if (scenes.length > 0) {
      brief.structure_analysis.total_scenes = scenes.length;
      const briefScenes: Array<Record<string, any>> = [];
      for (const scene of scenes) {
        briefScenes.push({
          scene_index: scene.index ?? scene.scene_index ?? 0,
          start_time: scene.start_seconds ?? 0,
          end_time: scene.end_seconds ?? 0,
          description: "", // Agent fills this via vision
          visual_type: "other", // Agent classifies via vision
          energy_level: "medium",
        });
      }
      brief.structure_analysis.scenes = briefScenes;

      // Compute pacing profile
      const durations = scenes.map(
        (s) => (s.end_seconds ?? 0) - (s.start_seconds ?? 0)
      );
      const totalDuration =
        brief.source.duration_seconds || durations.reduce((a, b) => a + b, 0);
      if (durations.length > 0) {
        brief.structure_analysis.pacing_profile = {
          avg_scene_duration_seconds: round(
            durations.reduce((a, b) => a + b, 0) / durations.length,
            2
          ),
          shortest_scene_seconds: round(Math.min(...durations), 2),
          longest_scene_seconds: round(Math.max(...durations), 2),
          cuts_per_minute:
            totalDuration > 0
              ? round(durations.length / (totalDuration / 60), 2)
              : 0,
          pacing_style: this._classifyPacing(durations),
        };
      }
    }

    // ─── STEP 3b: Motion classification per scene ───
    if (videoPath && scenes.length > 0) {
      try {
        const motionResults = this._classifySceneMotion(videoPath, scenes);
        const briefScenes = brief.structure_analysis.scenes as Array<Record<string, any>>;
        for (let i = 0; i < Math.min(briefScenes.length, motionResults.length); i++) {
          briefScenes[i]!.motion_type = motionResults[i]!.motion_type;
          briefScenes[i]!.flow_variance = motionResults[i]!.flow_variance;
        }
        stepsCompleted.push("motion_classification");
      } catch (e) {
        stepsFailed.push(`motion_classification: ${(e as Error).message ?? e}`);
      }
    }

    // ─── STEP 4: Keyframe extraction (scene-guided) ───
    const keyframes: Array<Record<string, any>> = [];
    const keyframeDir = path.join(outputDir, "keyframes");
    if (videoPath && scenes.length > 0) {
      try {
        // Extract keyframes at scene boundaries + midpoints
        const timestamps = this._computeKeyframeTimestamps(scenes, maxKeyframes, depth);

        const sampler = new FrameSampler();
        const fsResult = await sampler.execute({
          input_path: videoPath,
          strategy: "timestamps",
          timestamps,
          output_dir: keyframeDir,
          format: "jpg",
          quality: 2,
        });
        if (fsResult.success) {
          for (const frame of (fsResult.data?.frames as Array<Record<string, any>>) ?? []) {
            // Map each frame to its scene
            const sceneIdx = this._timestampToScene(frame.timestamp_seconds, scenes);
            keyframes.push({
              timestamp: frame.timestamp_seconds,
              scene_index: sceneIdx,
              path: frame.path,
              description: "", // Agent fills via vision
            });
          }
          stepsCompleted.push("keyframes");
        }
      } catch (e) {
        stepsFailed.push(`keyframes: ${(e as Error).message ?? e}`);
      }
    } else if (videoPath && scenes.length === 0) {
      // No scene detection — fall back to count-based extraction
      try {
        const sampler = new FrameSampler();
        const fsResult = await sampler.execute({
          input_path: videoPath,
          strategy: "count",
          count: Math.min(maxKeyframes, 15),
          output_dir: keyframeDir,
          format: "jpg",
          quality: 2,
        });
        if (fsResult.success) {
          for (const frame of (fsResult.data?.frames as Array<Record<string, any>>) ?? []) {
            keyframes.push({
              timestamp: frame.timestamp_seconds,
              scene_index: 0,
              path: frame.path,
              description: "",
            });
          }
          stepsCompleted.push("keyframes_uniform");
        }
      } catch (e) {
        stepsFailed.push(`keyframes_uniform: ${(e as Error).message ?? e}`);
      }
    }

    brief.keyframes = keyframes;

    // ─── STEP 5: Audio energy analysis ───
    if (audioPath || videoPath) {
      const audioSource = audioPath || videoPath;
      try {
        const energy = new AudioEnergy();
        const aeResult = await energy.execute({
          input_path: audioSource as string,
          video_duration_seconds: brief.source.duration_seconds,
        });
        if (aeResult.success) {
          // Store energy profile summary in style_profile
          if (!("style_profile" in brief)) {
            brief.style_profile = {};
          }
          brief.style_profile.audio_energy_profile = {
            recommended_offset: aeResult.data?.recommended_offset_seconds ?? 0,
            has_energy_data: true,
          };
          stepsCompleted.push("audio_energy");
        }
      } catch (e) {
        stepsFailed.push(`audio_energy: ${(e as Error).message ?? e}`);
      }
    }

    // ─── STEP 6: Build replication guidance ───
    brief.replication_guidance = {
      suggested_pipeline: this._suggestPipeline(brief),
      suggested_playbook: "flat-motion-graphics",
      key_elements_to_replicate: [], // Agent fills via analysis
      elements_requiring_custom_work: [],
      estimated_complexity: this._estimateComplexity(brief),
      motion_required: this._needsMotion(brief),
      creative_differentiation_seeds: [], // Agent fills
    };

    // ─── STEP 7: Initialize style_profile ───
    if (!("style_profile" in brief)) {
      brief.style_profile = {};
    }

    // Narration style from transcript
    if (transcriptData) {
      const duration = brief.source.duration_seconds;
      const wc =
        typeof transcriptData === "object" && transcriptData !== null
          ? transcriptData.word_count ?? 0
          : brief.narration_transcript?.word_count ?? 0;
      const wpm = duration > 0 ? round(wc / (duration / 60), 1) : 0;
      brief.style_profile.narration_style = {
        has_narration: wc > 20,
        speaker_count: 1, // Agent refines via analysis
        delivery_style: "", // Agent fills
        words_per_minute: wpm,
      };
    }

    // Initialize remaining style fields for agent to fill
    setdefault(brief.style_profile, "color_palette", {
      primary_colors: [],
      accent_colors: [],
      overall_mood: "",
    });
    setdefault(brief.style_profile, "typography_observed", "");
    setdefault(brief.style_profile, "transition_types", []);
    setdefault(brief.style_profile, "music_style", "");
    setdefault(brief.style_profile, "subtitle_style", "");
    setdefault(brief.style_profile, "production_quality", "prosumer");
    setdefault(brief.style_profile, "closest_playbook", "");
    setdefault(brief.style_profile, "playbook_delta", "");

    // ─── Finalize ───
    brief._analysis_meta = {
      depth,
      steps_completed: stepsCompleted,
      steps_failed: stepsFailed,
      keyframe_count: keyframes.length,
      scene_count: scenes.length,
      has_transcript: transcriptData !== null,
      duration_seconds: round((Date.now() - start) / 1000, 2),
    };

    this._saveBrief(brief, outputDir);

    const elapsed = (Date.now() - start) / 1000;
    const artifacts = [path.join(outputDir, "video_analysis_brief.json")];
    if (fs.existsSync(keyframeDir)) {
      artifacts.push(keyframeDir);
    }

    return toolResult({
      success: true,
      data: brief,
      artifacts,
      duration_seconds: round(elapsed, 2),
    });
  }

  // ─── Helpers ───

  /**
   * Dynamic import that returns null if the module is absent. Used for the
   * not-yet-ported transcriber / transcript_fetcher (later wave). Relative
   * specifiers are resolved against this module's URL.
   */
  private async _tryImport(specifier: string): Promise<unknown | null> {
    try {
      const resolved = specifier.startsWith(".")
        ? new URL(specifier, import.meta.url).href
        : specifier;
      return await import(resolved);
    } catch {
      return null;
    }
  }

  /** Get video duration via ffprobe. */
  private async _getDuration(videoPath: string): Promise<number> {
    const cmd = [
      "ffprobe",
      "-v",
      "quiet",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
      videoPath,
    ];
    const result = await this.runCommand(cmd);
    const data = JSON.parse(String(result.stdout ?? "")) as {
      format?: { duration?: string };
    };
    return parseFloat(String(data.format?.duration ?? 0));
  }

  /** Compute optimal keyframe timestamps from scene boundaries. */
  private _computeKeyframeTimestamps(
    scenes: Array<Record<string, any>>,
    maxFrames: number,
    depth: string
  ): number[] {
    let timestamps: number[] = [];

    for (const scene of scenes) {
      const sceneStart = scene.start_seconds ?? 0;
      const end = scene.end_seconds ?? 0;
      const duration = end - sceneStart;

      // First frame of each scene
      timestamps.push(sceneStart + 0.1);

      // Midpoint for scenes > 3 seconds
      if (duration > 3.0) {
        timestamps.push(sceneStart + duration / 2);
      }

      // For deep analysis, add more intra-scene samples
      if (depth === "deep" && duration > 6.0) {
        timestamps.push(sceneStart + duration * 0.25);
        timestamps.push(sceneStart + duration * 0.75);
      }
    }

    // Deduplicate, sort, and limit
    timestamps = uniqueSortedRounded(timestamps, 3);
    if (timestamps.length > maxFrames) {
      // Uniform subsample to max_frames
      const step = timestamps.length / maxFrames;
      const limited: number[] = [];
      for (let i = 0; i < maxFrames; i++) {
        limited.push(timestamps[Math.trunc(i * step)]!);
      }
      timestamps = limited;
    }

    return timestamps;
  }

  /** Map a timestamp to its scene index. */
  private _timestampToScene(ts: number, scenes: Array<Record<string, any>>): number {
    for (const scene of scenes) {
      const start = scene.start_seconds ?? 0;
      const end = scene.end_seconds ?? 0;
      if (start <= ts && ts <= end) {
        return scene.index ?? scene.scene_index ?? 0;
      }
    }
    return 0;
  }

  /** Classify pacing style from scene durations. */
  private _classifyPacing(durations: number[]): string {
    if (durations.length === 0) {
      return "variable";
    }
    const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
    if (avg > 10) return "slow_contemplative";
    if (avg > 5) return "steady_educational";
    if (avg > 2) return "dynamic_social";
    return "rapid_fire";
  }

  /** Suggest the best pipeline based on content analysis. */
  private _suggestPipeline(brief: Record<string, any>): string {
    const platform = brief.source.type;
    const pacing = brief.structure_analysis?.pacing_profile?.pacing_style ?? "";

    if (platform === "shorts" || platform === "tiktok" || platform === "instagram") {
      return "animation"; // Short-form → animation pipeline works well
    }
    if (pacing === "slow_contemplative") {
      return "cinematic";
    }
    return "animated-explainer";
  }

  /** Estimate how complex it would be to recreate this style. */
  private _estimateComplexity(brief: Record<string, any>): string {
    const scenes = brief.structure_analysis.total_scenes;
    const duration = brief.source.duration_seconds;

    if (duration > 300 || scenes > 30) return "complex";
    if (duration > 120 || scenes > 15) return "moderate";
    return "simple";
  }

  /** Determine if motion (video gen or Remotion) is required. */
  private _needsMotion(brief: Record<string, any>): boolean {
    // If we have per-scene motion data, use it — majority motion_clip = motion required
    const scenes = (brief.structure_analysis?.scenes as Array<Record<string, any>>) ?? [];
    const motionScenes = scenes.filter((s) => s.motion_type === "motion_clip");
    if (scenes.length > 0 && motionScenes.length > 0) {
      return motionScenes.length / scenes.length >= 0.3;
    }
    // Fallback to pacing heuristic
    const pacing = brief.structure_analysis?.pacing_profile?.pacing_style ?? "";
    return pacing === "dynamic_social" || pacing === "rapid_fire";
  }

  /**
   * Classify each scene as static_image, animated_still, or motion_clip.
   *
   * DEVIATION: Python samples 2-3 frame pairs per scene and computes dense
   * optical flow variance via cv2.calcOpticalFlowFarneback + numpy (downscaling
   * to 360p, 0.4s gap). OpenCV/numpy are Python-only CV libs with no clean Node
   * port. The Python code itself returns
   *   [{"motion_type": "unknown", "flow_variance": -1}] * len(scenes)
   * when `import cv2` fails; the TS port returns exactly that (cv2 never exists
   * in Node). The Farneback thresholds documented for fidelity:
   *   - static_image:   avg flow magnitude < 0.5 (no motion at all)
   *   - animated_still: flow variance < 2.0 (uniform pan/zoom on a still)
   *   - motion_clip:    otherwise (heterogeneous flow — independent motion)
   */
  private _classifySceneMotion(
    _videoPath: string,
    scenes: Array<Record<string, any>>
  ): Array<{ motion_type: string; flow_variance: number }> {
    // cv2 unavailable in the Node runtime — degrade exactly like Python's
    // ImportError branch.
    return scenes.map(() => ({ motion_type: "unknown", flow_variance: -1 }));
  }

  /** Save the VideoAnalysisBrief to disk. */
  private _saveBrief(brief: Record<string, any>, outputDir: string): void {
    const outPath = path.join(outputDir, "video_analysis_brief.json");
    // Remove non-serializable items (shallow copy, matches Python clean_brief).
    const cleanBrief = { ...brief };
    fs.writeFileSync(outPath, JSON.stringify(cleanBrief, null, 2), {
      encoding: "utf-8",
    });
  }
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Python: sorted(set(round(t, 3) for t in timestamps)). */
function uniqueSortedRounded(values: number[], digits: number): number[] {
  const seen = new Set<number>();
  for (const v of values) {
    seen.add(round(v, digits));
  }
  return [...seen].sort((a, b) => a - b);
}

/** Mirror dict.setdefault: set key only if absent. */
function setdefault(obj: Record<string, any>, key: string, value: unknown): void {
  if (!(key in obj)) {
    obj[key] = value;
  }
}

/** Python Path.stem: filename without its final extension. */
function stem(filePath: string): string {
  const base = path.basename(filePath);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}
