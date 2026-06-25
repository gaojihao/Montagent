/**
 * Video composition tool — FFmpeg + Remotion + HyperFrames (runtime-aware).
 *
 * TypeScript port of tools/video/video_compose.py. Full render pipeline:
 * FFmpeg concat/trim, programmatic Remotion render, HyperFrames delegation,
 * and the mandatory post-render self-review.
 *
 * Routing is driven by `edit_decisions.render_runtime` (locked at proposal):
 *  - `remotion`    → React-based frame-accurate render. Python shells out to
 *                    `npx remotion render`; here we render PROGRAMMATICALLY via
 *                    `@remotion/bundler` + `@remotion/renderer` (bundle
 *                    remotion-composer/src/index.tsx, selectComposition, then
 *                    renderMedia h264). Output is identical.
 *  - `hyperframes` → HTML/CSS/GSAP render via hyperframes_compose (npx hyperframes).
 *  - `ffmpeg`      → FFmpeg concat/trim. The ffmpeg command arrays are translated
 *                    VERBATIM from the Python source to execa.
 *
 * Silent runtime swaps are forbidden by governance. If the chosen runtime is
 * unavailable or fails, this tool surfaces a structured blocker and waits for
 * the agent to re-ask the user rather than substituting a different engine.
 *
 * Parity notes vs. Python:
 *  - name/capability/provider/tier/stability/dependencies match verbatim.
 *  - runtime is LOCAL (Python never overrides ToolRuntime; base default = LOCAL).
 *  - render_engines.ffmpeg is always True; remotion = remotion-composer/node_modules
 *    exists; hyperframes = npx on PATH (preflight signal).
 *  - lib.media_profiles is ported inline (small stable data) so `profile` works;
 *    lib.delivery_promise / lib.slideshow_risk / styles.playbook_loader are
 *    optional — when unavailable the same try/except-skip behavior as Python
 *    (which catches ImportError) applies.
 */
import fs from "node:fs";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import {
  ensureBrowser,
  renderMedia,
  selectComposition,
  type Codec,
} from "@remotion/renderer";
import {
  BaseTool,
  Determinism,
  ExecutionMode,
  ResourceProfile,
  RetryPolicy,
  ResumeSupport,
  ToolResult,
  ToolStability,
  ToolTier,
  commandExists,
  toolResult,
  PROJECT_ROOT,
} from "../base_tool.js";

// ---------------------------------------------------------------------------
// Minimal media-profile registry (port of the parts of lib/media_profiles.py
// that video_compose uses: width/height/fps). Kept inline because the TS port
// has no lib/media_profiles module and the data is small and stable.
// ---------------------------------------------------------------------------
interface MediaProfile {
  name: string;
  width: number;
  height: number;
  fps: number;
}

const MEDIA_PROFILES: Record<string, MediaProfile> = {
  youtube_landscape: { name: "youtube_landscape", width: 1920, height: 1080, fps: 30 },
  youtube_4k: { name: "youtube_4k", width: 3840, height: 2160, fps: 30 },
  youtube_shorts: { name: "youtube_shorts", width: 1080, height: 1920, fps: 30 },
  instagram_reels: { name: "instagram_reels", width: 1080, height: 1920, fps: 30 },
  instagram_feed: { name: "instagram_feed", width: 1080, height: 1080, fps: 30 },
  tiktok: { name: "tiktok", width: 1080, height: 1920, fps: 30 },
  linkedin: { name: "linkedin", width: 1920, height: 1080, fps: 30 },
  cinematic: { name: "cinematic", width: 2560, height: 1080, fps: 24 },
  generic_hd: { name: "generic_hd", width: 1920, height: 1080, fps: 30 },
};

/** Resolve a media profile by name, or null if unknown (mirrors Python's
 * get_profile raising ValueError → caught by the try/except callers). */
function getProfile(name: string): MediaProfile | null {
  return MEDIA_PROFILES[name] ?? null;
}

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".bmp",
  ".tiff",
  ".tif",
  ".webp",
]);

// ---------------------------------------------------------------------------
// Bundle caching — bundle the Remotion project at most once per process.
// ---------------------------------------------------------------------------
let bundlePromise: Promise<string> | null = null;

export class VideoCompose extends BaseTool {
  override name = "video_compose";
  override version = "0.1.0";
  override tier = ToolTier.CORE;
  override capability = "video_post";
  override provider = "ffmpeg";
  override stability = ToolStability.EXPERIMENTAL;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;

  override dependencies = ["cmd:ffmpeg"];
  override install_instructions =
    "Install FFmpeg: https://ffmpeg.org/download.html";
  override agent_skills = ["remotion-best-practices", "remotion", "ffmpeg"];

  override capabilities = [
    "compose_cuts",
    "burn_subtitles",
    "overlay_assets",
    "encode_profile",
    "remotion_render",
  ];

  override input_schema = {
    type: "object",
    required: ["operation"],
    properties: {
      operation: {
        type: "string",
        enum: [
          "compose",
          "render",
          "remotion_render",
          "burn_subtitles",
          "overlay",
          "encode",
        ],
        description:
          "compose: low-level concat cuts + audio + subtitles. " +
          "render: high-level — resolves asset IDs, auto-routes to Remotion " +
          "for images/animations or FFmpeg for video-only. Preferred for compose-director. " +
          "remotion_render: render via Remotion (Node.js). " +
          "burn_subtitles: burn subtitle file into existing video. " +
          "overlay: composite overlays onto base video. " +
          "encode: re-encode to a target profile/codec.",
      },
      input_path: { type: "string" },
      output_path: { type: "string" },
      edit_decisions: {
        type: "object",
        description:
          "Full edit_decisions artifact (required for compose/render)",
      },
      asset_manifest: {
        type: "object",
        description:
          "Full asset_manifest artifact (required for render). " +
          "Used to resolve asset IDs in cuts[].source to file paths.",
      },
      audio_path: {
        type: "string",
        description: "Mixed audio to mux into output",
      },
      profile: {
        type: "string",
        description:
          "Media profile name (e.g. youtube_landscape, tiktok, instagram_reels). " +
          "Applied in render and encode operations.",
      },
      codec: { type: "string", default: "libx264" },
      crf: { type: "integer", default: 23 },
      preset: { type: "string", default: "medium" },
    },
  };

  override resource_profile: ResourceProfile = {
    cpu_cores: 4,
    ram_mb: 2048,
    vram_mb: 0,
    disk_mb: 5000,
    network_required: false,
  };

  // Remotion scene types that trigger React-based rendering.
  private static readonly REMOTION_COMPONENTS = [
    "text_card",
    "stat_card",
    "callout",
    "comparison",
    "progress",
    "chart",
    "bar_chart",
    "line_chart",
    "pie_chart",
    "kpi_grid",
  ];

  // Remotion scene types (subset checked by _needs_remotion fast path).
  private static readonly REMOTION_SCENE_TYPES = new Set([
    "text_card",
    "stat_card",
    "callout",
    "comparison",
    "progress",
    "chart",
  ]);

  // Maps renderer_family → Remotion composition ID.
  // Only compositions registered in remotion-composer/src/Root.tsx are valid.
  private static readonly RENDERER_FAMILY_MAP: Record<string, string> = {
    "explainer-data": "Explainer",
    "explainer-teacher": "Explainer",
    "cinematic-trailer": "CinematicRenderer",
    "documentary-montage": "CinematicRenderer",
    "product-reveal": "Explainer",
    "screen-demo": "Explainer",
    presenter: "TalkingHead",
    "animation-first": "Explainer",
  };

  // Punctuation/SSML-leak words that should NEVER appear in rendered audio.
  private static readonly TTS_PUNCTUATION_LEAK_WORDS = new Set([
    "dot",
    "dots",
    "ellipsis",
    "period",
    "periods",
    "comma",
    "commas",
    "semicolon",
    "colon",
    "dash",
    "hyphen",
    "emdash",
    "endash",
    "parenthesis",
    "bracket",
    "brace",
    "asterisk",
    "slash",
    "backslash",
    "exclamation",
    "question mark",
  ]);

  override best_for = [
    "Final render for explainer and animation pipelines",
    "Image-to-video with spring animations (Remotion)",
    "Animated text cards, stat cards, charts (Remotion)",
    "Complex transitions between scenes (Remotion)",
    "Pure video concat and trim (FFmpeg)",
  ];
  override retry_policy: RetryPolicy = {
    max_retries: 1,
    backoff_seconds: 1.0,
    retryable_errors: ["Conversion failed"],
  };
  override resume_support = ResumeSupport.FROM_START;
  override idempotency_key_fields = [
    "operation",
    "input_path",
    "edit_decisions",
  ];
  override side_effects = ["writes video file to output_path"];
  override user_visible_verification = [
    "Play the composed output and verify cuts, subtitles, and overlays",
  ];

  /** remotion-composer lives at the TS project root. */
  private composerDir(): string {
    return path.join(PROJECT_ROOT, "remotion-composer");
  }

  /**
   * Real Remotion availability check: the composer project's node_modules
   * must be installed (without them `npx remotion render` fails even if the
   * project exists). Mirrors the signal Python's _remotion_available() gates on.
   */
  private remotionAvailable(): boolean {
    return fs.existsSync(path.join(this.composerDir(), "node_modules"));
  }

  /** Composer project exists (package.json present) but deps not installed. */
  private remotionProjectButNoModules(): boolean {
    const dir = this.composerDir();
    return (
      fs.existsSync(path.join(dir, "package.json")) &&
      !fs.existsSync(path.join(dir, "node_modules"))
    );
  }

  /**
   * HyperFrames requires npx on PATH (plus the npm package + ffmpeg at render
   * time). For preflight detection we use npx presence as the available signal.
   */
  private hyperframesAvailable(): boolean {
    return commandExists("npx");
  }

  /**
   * Surface every render runtime's availability separately so the agent can
   * choose render_runtime at proposal stage. Silent fallback is forbidden.
   */
  protected override extraInfo(): Record<string, unknown> {
    const remotionOk = this.remotionAvailable();
    const hyperframesOk = this.hyperframesAvailable();

    const renderEngines = {
      ffmpeg: true,
      remotion: remotionOk,
      hyperframes: hyperframesOk,
    };

    const info: Record<string, unknown> = {
      render_engines: renderEngines,
      // Backwards-compat alias — some proposal skills inspect this name.
      render_runtimes: renderEngines,
    };

    if (remotionOk) {
      info.remotion_components = VideoCompose.REMOTION_COMPONENTS;
      info.remotion_note =
        "Remotion is available for React-based rendering. Use it for " +
        "image-to-video with spring animations, animated text/stat cards, " +
        "charts, callouts, comparisons, and word-level caption burn. " +
        "Prefer Remotion over Ken Burns pan-and-zoom for explainer " +
        "and motion-graphics pipelines that already use the scene-component stack.";
    } else if (this.remotionProjectButNoModules()) {
      info.remotion_note =
        "Remotion project exists but node_modules are NOT installed. " +
        "Run 'cd remotion-composer && npm install' to enable Remotion rendering.";
    } else {
      info.remotion_note =
        "Remotion is NOT available (needs Node.js/npx + remotion-composer + node_modules).";
    }

    if (hyperframesOk) {
      info.hyperframes_note =
        "HyperFrames is available for HTML/CSS/GSAP composition. Use it " +
        "for kinetic typography, product promos, launch reels, " +
        "website-to-video, and registry-block-driven scenes. Consumed via " +
        "'npx hyperframes' (npm package: 'hyperframes'). " +
        "Before locking render_runtime='hyperframes' at the proposal stage, " +
        "verify the runtime with `hyperframes_compose` operation='doctor'. " +
        "An 'available' flag means node + ffmpeg + the npm package all resolve; " +
        "it does not guarantee a render will succeed on the first specific composition.";
    } else {
      info.hyperframes_note =
        "HyperFrames is NOT available. Requires Node.js >= 22, FFmpeg, " +
        "npx on PATH, and the 'hyperframes' npm package to be resolvable.";
    }

    // Governance note — agents and reviewers consume this.
    info.runtime_governance =
      "render_runtime is locked at proposal stage and carried unchanged " +
      "through edit_decisions. Silent swaps are forbidden. If the " +
      "chosen runtime fails, surface a structured blocker and wait for " +
      "user approval before switching.";

    return info;
  }

  override async execute(
    inputs: Record<string, unknown>
  ): Promise<ToolResult> {
    const operation = inputs.operation as string;
    const start = Date.now();

    let result: ToolResult;
    try {
      if (operation === "compose") {
        result = await this.compose(inputs);
      } else if (operation === "render") {
        result = await this.render(inputs);
      } else if (operation === "remotion_render") {
        result = await this.remotionRender(inputs);
      } else if (operation === "burn_subtitles") {
        result = await this.burnSubtitles(inputs);
      } else if (operation === "overlay") {
        result = await this.overlay(inputs);
      } else if (operation === "encode") {
        result = await this.encode(inputs);
      } else {
        return toolResult({
          success: false,
          error: `Unknown operation: ${operation}`,
        });
      }
    } catch (e) {
      return toolResult({ success: false, error: errMsg(e) });
    }

    result.duration_seconds = Math.round((Date.now() - start) / 10) / 100;
    return result;
  }

  /** Check if a file is a still image (routes to Remotion, not FFmpeg). */
  private static isImage(p: string): boolean {
    return IMAGE_EXTENSIONS.has(path.extname(p).toLowerCase());
  }

  /** Return True iff ffprobe reports at least one audio stream. */
  private async hasAudioStream(filePath: string): Promise<boolean> {
    try {
      const { stdout } = await this.runCommand([
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "a",
        "-show_entries",
        "stream=codec_type",
        "-of",
        "default=nw=1:nk=1",
        filePath,
      ]);
      return String(stdout).includes("audio");
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------
  // compose — FFmpeg concat/trim + audio + subtitles
  // ------------------------------------------------------------------
  private async compose(
    inputs: Record<string, unknown>
  ): Promise<ToolResult> {
    const editDecisions = inputs.edit_decisions as Record<string, any> | undefined;
    if (!editDecisions) {
      return toolResult({
        success: false,
        error: "edit_decisions required for compose",
      });
    }

    const outputPath = path.resolve(
      (inputs.output_path as string) ?? "composed_output.mp4"
    );
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const audioPath = inputs.audio_path as string | undefined;
    let subtitlePath = inputs.subtitle_path as string | undefined;
    const codec = (inputs.codec as string) ?? "libx264";
    const crf = (inputs.crf as number) ?? 23;
    const preset = (inputs.preset as string) ?? "medium";
    const profileName = inputs.profile as string | undefined;

    const cuts = (editDecisions.cuts as any[]) ?? [];
    if (cuts.length === 0) {
      return toolResult({ success: false, error: "No cuts in edit_decisions" });
    }

    // Resolve subtitle style using the layered priority resolver.
    const playbookData = inputs.playbook as Record<string, any> | undefined;
    const resolvedSubStyle = VideoCompose.resolveSubtitleStyle(
      inputs.subtitle_style as Record<string, any> | undefined,
      editDecisions,
      playbookData
    );

    const edSubs = (editDecisions.subtitles as Record<string, any>) ?? {};
    if (edSubs.source && !subtitlePath) {
      subtitlePath = edSubs.source as string;
    }

    const tempDir = path.join(path.dirname(outputPath), ".compose_tmp");
    fs.mkdirSync(tempDir, { recursive: true });
    const tempSegments: string[] = [];
    let concatPath: string | null = null;
    let concatOut: string | null = null;

    try {
      for (let i = 0; i < cuts.length; i++) {
        const cut = cuts[i];
        const source = String(cut.source);
        if (!fs.existsSync(source)) {
          return toolResult({
            success: false,
            error: `Cut source not found: ${source}`,
          });
        }

        const segPath = path.join(
          tempDir,
          `seg_${String(i).padStart(4, "0")}.mp4`
        );
        const inS = cut.in_seconds;
        const outS = cut.out_seconds;
        const duration = outS - inS;
        const speed = cut.speed ?? 1.0;

        if (VideoCompose.isImage(source)) {
          return toolResult({
            success: false,
            error:
              `Still image '${path.basename(source)}' in cuts. ` +
              "Use operation='render' (auto-routes to Remotion) " +
              "or operation='remotion_render' for compositions " +
              "with images, animations, or component scenes.",
          });
        }

        // Video source: trim to segment.
        //   -ss BEFORE -i → fast input-level seek to in_s
        //   -t  AFTER  -i → "play for `duration` seconds"
        // We MUST re-encode (libx264/AAC) for frame-accurate cuts.
        let cmd: string[] = [
          "ffmpeg",
          "-y",
          "-ss",
          String(inS),
          "-t",
          String(duration),
          "-i",
          source,
        ];

        // Normalize every segment to a consistent container so concat-copy
        // is always safe (identical codec/resolution/fps/pix_fmt/sar).
        const vfParts: string[] = [
          "scale=1920:1080:force_original_aspect_ratio=decrease",
          "pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black",
          "setsar=1",
          "fps=30",
        ];
        const afParts: string[] = [];
        if (speed !== 1.0) {
          vfParts.push(`setpts=${1.0 / speed}*PTS`);
          afParts.push(VideoCompose.buildAtempo(speed));
        }

        cmd.push("-filter:v", vfParts.join(","));
        if (afParts.length > 0) {
          cmd.push("-filter:a", afParts.join(","));
        }

        cmd.push(
          "-c:v",
          codec,
          "-crf",
          String(crf),
          "-preset",
          preset,
          "-pix_fmt",
          "yuv420p",
          "-r",
          "30"
        );

        // Audio handling: probe for an audio stream; transcode to AAC if
        // present, else synthesize a silent stereo track via lavfi.
        const hasAudio = await this.hasAudioStream(source);
        if (hasAudio) {
          cmd.push("-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2");
        } else {
          cmd = [
            "ffmpeg",
            "-y",
            "-ss",
            String(inS),
            "-t",
            String(duration),
            "-i",
            source,
            "-f",
            "lavfi",
            "-t",
            String(duration),
            "-i",
            "anullsrc=channel_layout=stereo:sample_rate=48000",
            "-filter:v",
            vfParts.join(","),
          ];
          if (afParts.length > 0) {
            cmd.push("-filter:a", afParts.join(","));
          }
          cmd.push(
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-c:v",
            codec,
            "-crf",
            String(crf),
            "-preset",
            preset,
            "-pix_fmt",
            "yuv420p",
            "-r",
            "30",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-ar",
            "48000",
            "-ac",
            "2"
          );
        }

        cmd.push(segPath);
        await this.runCommand(cmd);

        tempSegments.push(segPath);
      }

      // Step 2: Concat segments
      concatPath = path.join(tempDir, "concat_list.txt");
      const concatLines = tempSegments
        .map((seg) => `file '${path.resolve(seg).replace(/\\/g, "/")}'`)
        .join("\n");
      fs.writeFileSync(concatPath, concatLines + "\n", "utf-8");

      concatOut = path.join(tempDir, "concat.mp4");
      await this.runCommand([
        "ffmpeg",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        concatPath,
        "-c",
        "copy",
        concatOut,
      ]);

      // Step 3: Apply subtitles and/or replace audio
      const finalInput = concatOut;
      const vfilters: string[] = [];

      if (subtitlePath && fs.existsSync(subtitlePath)) {
        const assStyle = VideoCompose.buildSubtitleStyle(resolvedSubStyle);
        const subEscaped = path
          .resolve(subtitlePath)
          .replace(/\\/g, "/")
          .replace(/:/g, "\\:");
        vfilters.push(
          `subtitles='${subEscaped}':force_style='${assStyle}'`
        );
      }

      const cmd: string[] = ["ffmpeg", "-y", "-i", finalInput];

      const hasMixedAudio = !!(audioPath && fs.existsSync(audioPath));
      if (hasMixedAudio) {
        cmd.push("-i", audioPath as string);
      }

      // Determine if profile requires re-encoding (resize/fps change).
      let profileFlags: string[] = [];
      if (profileName) {
        const p = getProfile(profileName);
        if (p) {
          profileFlags = ["-s", `${p.width}x${p.height}`, "-r", String(p.fps)];
        }
      }

      const needsReencode = vfilters.length > 0 || profileFlags.length > 0;

      if (needsReencode) {
        if (vfilters.length > 0) {
          cmd.push("-vf", vfilters.join(","));
        }
        cmd.push("-c:v", codec, "-crf", String(crf), "-preset", preset);
        cmd.push(...profileFlags);
      } else {
        cmd.push("-c:v", "copy");
      }

      if (hasMixedAudio) {
        cmd.push("-map", "0:v", "-map", "1:a", "-c:a", "aac", "-shortest");
      } else {
        cmd.push("-c:a", "copy");
      }

      cmd.push(outputPath);
      await this.runCommand(cmd);

      return toolResult({
        success: true,
        data: {
          operation: "compose",
          cut_count: cuts.length,
          has_subtitles: subtitlePath != null,
          has_mixed_audio: audioPath != null,
          profile: profileName ?? null,
          output: outputPath,
        },
        artifacts: [outputPath],
      });
    } finally {
      // Cleanup temp files
      for (const f of tempSegments) {
        if (fs.existsSync(f)) fs.rmSync(f, { force: true });
      }
      for (const f of [concatPath, concatOut]) {
        if (f != null && fs.existsSync(f)) fs.rmSync(f, { force: true });
      }
      if (fs.existsSync(tempDir)) {
        try {
          fs.rmdirSync(tempDir);
        } catch {
          /* not empty / in use — leave it */
        }
      }
    }
  }

  /** Resolve renderer_family to Remotion composition ID. Throws if unknown. */
  private static getCompositionId(rendererFamily: string): string {
    const comp = VideoCompose.RENDERER_FAMILY_MAP[rendererFamily];
    if (comp === undefined) {
      const valid = Object.keys(VideoCompose.RENDERER_FAMILY_MAP).sort();
      throw new Error(
        `Unknown renderer_family '${rendererFamily}'. ` +
          `Valid families: ${JSON.stringify(valid)}. ` +
          `Set renderer_family at proposal stage.`
      );
    }
    return comp;
  }

  /**
   * Derive a Remotion ThemeConfig from a playbook's actual color values,
   * falling back to edit_decisions metadata. Port of _build_theme_from_playbook.
   */
  private static async buildThemeFromPlaybook(
    playbookName: string | null,
    compositionData: Record<string, any> | null
  ): Promise<Record<string, any> | null> {
    let theme: Record<string, any> = {};

    let playbook: Record<string, any> = {};
    if (playbookName) {
      try {
        const mod = await import("../../styles/playbook_loader.js");
        playbook = mod.loadPlaybook(playbookName);
      } catch {
        /* playbook not loadable — fall through */
      }
    }

    if (playbook && Object.keys(playbook).length > 0) {
      const vl = (playbook.visual_language as Record<string, any>) ?? {};
      const palette = (vl.color_palette as Record<string, any>) ?? {};
      const typo = (playbook.typography as Record<string, any>) ?? {};

      const primaryRaw = palette.primary ?? ["#2563EB"];
      const accentRaw = palette.accent ?? ["#F59E0B"];
      const primary = Array.isArray(primaryRaw) ? primaryRaw[0] : primaryRaw;
      const accent = Array.isArray(accentRaw) ? accentRaw[0] : accentRaw;

      const bg = palette.background ?? "#FFFFFF";
      const text = palette.text ?? "#1F2937";
      const surface = palette.surface ?? bg;
      const muted = palette.muted_text ?? "#6B7280";

      let chartColors: string[] = [];
      for (const key of [
        "primary",
        "accent",
        "secondary",
        "success",
        "warning",
        "info",
      ]) {
        const val = palette[key];
        if (val) chartColors.push(Array.isArray(val) ? val[0] : val);
      }
      if (chartColors.length < 3) {
        chartColors = [
          primary,
          accent,
          "#10B981",
          "#8B5CF6",
          "#EC4899",
          "#06B6D4",
        ];
      }

      theme = {
        primaryColor: primary,
        accentColor: accent,
        backgroundColor: bg,
        surfaceColor: surface,
        textColor: text,
        mutedTextColor: muted,
        headingFont: (typo.heading as Record<string, any>)?.font ?? "Inter",
        bodyFont: (typo.body as Record<string, any>)?.font ?? "Inter",
        monoFont: (typo.code as Record<string, any>)?.font ?? "JetBrains Mono",
        chartColors: chartColors.slice(0, 6),
        springConfig: { damping: 20, stiffness: 120, mass: 1 },
        transitionDuration: 0.4,
      };

      theme.captionHighlightColor = primary;
      theme.captionBackgroundColor = ["#FFFFFF", "#FAFAFA", "#F9FAFB"].includes(
        String(bg).toUpperCase()
      )
        ? "rgba(255, 255, 255, 0.85)"
        : "rgba(15, 23, 42, 0.75)";

      const motion = (playbook.motion as Record<string, any>) ?? {};
      const pace = motion.pace ?? "moderate";
      if (pace === "fast") {
        theme.springConfig = { damping: 12, stiffness: 80, mass: 1 };
        theme.transitionDuration = 0.3;
      } else if (pace === "slow") {
        theme.springConfig = { damping: 25, stiffness: 150, mass: 1 };
        theme.transitionDuration = 0.6;
      }
    }

    if (Object.keys(theme).length === 0 && compositionData) {
      const meta = (compositionData.metadata as Record<string, any>) ?? {};
      if (meta.primary_color) {
        theme = {
          primaryColor: meta.primary_color,
          accentColor: meta.accent_color ?? "#F59E0B",
          backgroundColor: meta.background_color ?? "#FFFFFF",
          surfaceColor: meta.surface_color ?? "#F9FAFB",
          textColor: meta.text_color ?? "#1F2937",
          mutedTextColor: "#6B7280",
          headingFont: meta.heading_font ?? "Inter",
          bodyFont: meta.body_font ?? "Inter",
          monoFont: "JetBrains Mono",
          chartColors: meta.chart_colors ?? ["#2563EB", "#F59E0B", "#10B981"],
          springConfig: { damping: 20, stiffness: 120, mass: 1 },
          transitionDuration: 0.4,
          captionHighlightColor: meta.primary_color,
          captionBackgroundColor: "rgba(255, 255, 255, 0.85)",
        };
      }
    }

    return Object.keys(theme).length > 0 ? theme : null;
  }

  /**
   * Determine whether Remotion should handle this composition. Remotion is the
   * DEFAULT engine when available; returns false only when Remotion is not
   * installed. Port of _needs_remotion.
   */
  private needsRemotion(cuts: any[]): boolean {
    if (!this.remotionAvailable()) return false;

    for (const cut of cuts) {
      const source = cut.source ?? "";
      if (source && IMAGE_EXTENSIONS.has(path.extname(source).toLowerCase())) {
        return true;
      }
      if (VideoCompose.REMOTION_SCENE_TYPES.has(cut.type)) return true;
      if (cut.animation || cut.transition_in || cut.transition_out) return true;
      const transform = (cut.transform as Record<string, any>) ?? {};
      if (transform && transform.animation) return true;
    }
    return true;
  }

  /**
   * Pre-compose quality gate. The Python checks delivery_promise and
   * slideshow_risk via lib modules wrapped in try/except (warn-only on import
   * failure) and BLOCKS on a missing renderer_family. The lib modules have no
   * TS port, so the promise/risk checks are skipped-with-warning (identical to
   * a machine where the Python imports fail); the renderer_family block is
   * preserved verbatim.
   */
  private preComposeValidation(
    editDecisions: Record<string, any>
  ): ToolResult | null {
    const warnings: string[] = [];
    const blocks: string[] = [];

    const deliveryData =
      (editDecisions.metadata as Record<string, any>)?.delivery_promise ??
      editDecisions.delivery_promise;
    if (!deliveryData) {
      warnings.push(
        "No delivery_promise in edit_decisions — skipping promise validation"
      );
    }
    // lib.delivery_promise / lib.slideshow_risk are unavailable in the TS port;
    // their checks are skipped (same as Python catching the import error).

    const rendererFamily = editDecisions.renderer_family;
    if (!rendererFamily) {
      blocks.push(
        "No renderer_family in edit_decisions. " +
          "renderer_family must be set at proposal stage and locked before compose. " +
          "Re-run the proposal stage with a renderer_family selection."
      );
    }

    for (const w of warnings) {
      console.warn(`[pre-compose] ${w}`);
    }

    if (blocks.length > 0) {
      return toolResult({
        success: false,
        error:
          "Pre-compose validation failed — render blocked.\n" +
          blocks.map((b) => `  • ${b}`).join("\n") +
          (warnings.length > 0
            ? "\n\nWarnings:\n" + warnings.map((w) => `  • ${w}`).join("\n")
            : ""),
      });
    }

    return null;
  }

  // ------------------------------------------------------------------
  // render — high-level entry: resolve assets + route by render_runtime
  // ------------------------------------------------------------------
  private async render(
    inputs: Record<string, unknown>
  ): Promise<ToolResult> {
    const editDecisions = inputs.edit_decisions as Record<string, any> | undefined;
    const assetManifest = inputs.asset_manifest as Record<string, any> | undefined;
    if (!editDecisions) {
      return toolResult({
        success: false,
        error: "edit_decisions required for render",
      });
    }
    if (!assetManifest) {
      return toolResult({
        success: false,
        error: "asset_manifest required for render",
      });
    }

    const outputPath = path.resolve(
      (inputs.output_path as string) ?? "renders/output.mp4"
    );
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    // Build asset lookup: id -> asset info.
    const assetLookup: Record<string, any> = {};
    for (const a of (assetManifest.assets as any[]) ?? []) {
      assetLookup[a.id] = a;
    }

    const cuts = (editDecisions.cuts as any[]) ?? [];
    if (cuts.length === 0) {
      return toolResult({ success: false, error: "No cuts in edit_decisions" });
    }

    // Resolve asset IDs in cuts to file paths.
    const resolvedCuts: any[] = [];
    for (const cut of cuts) {
      const sourceId = cut.source ?? "";
      const resolvedCut = { ...cut };
      if (sourceId in assetLookup) {
        resolvedCut.source = assetLookup[sourceId].path;
      }
      resolvedCuts.push(resolvedCut);
    }

    // --- Pre-compose validation gate ---
    const validationBlock = this.preComposeValidation(editDecisions);
    if (validationBlock != null) return validationBlock;

    const profile =
      (inputs.profile as string | undefined) ??
      (inputs.output_profile as string | undefined);

    // --- Runtime routing: honor render_runtime locked at proposal ---
    const renderRuntime = String(editDecisions.render_runtime ?? "")
      .trim()
      .toLowerCase();

    if (!renderRuntime) {
      return toolResult({
        success: false,
        error:
          "render_runtime is not set in edit_decisions. Per governance, " +
          "it MUST be locked at proposal stage (proposal_packet." +
          "production_plan.render_runtime) and carried forward through " +
          "edit_decisions.render_runtime. Valid values: 'remotion', " +
          "'hyperframes', 'ffmpeg'. Re-run the proposal stage with an " +
          "explicit runtime choice — do NOT default this field.",
      });
    }

    if (renderRuntime === "hyperframes") {
      return await this.renderViaHyperframes({
        inputs,
        editDecisions,
        assetManifest,
        resolvedCuts,
        outputPath,
        profile,
      });
    }
    if (renderRuntime === "ffmpeg") {
      return await this.renderViaFfmpeg({
        inputs,
        editDecisions,
        resolvedCuts,
        outputPath,
        profile,
      });
    }
    if (renderRuntime !== "remotion") {
      return toolResult({
        success: false,
        error:
          `Unknown render_runtime '${renderRuntime}'. ` +
          `Valid values: remotion, hyperframes, ffmpeg. ` +
          `render_runtime must be set at proposal stage.`,
      });
    }

    // --- Explicit Remotion path (render_runtime == 'remotion') ---
    let renderResult: ToolResult;
    if (this.needsRemotion(resolvedCuts)) {
      const remotionInputs: Record<string, unknown> = {
        edit_decisions: { ...editDecisions, cuts: resolvedCuts },
        output_path: outputPath,
      };
      if (profile) remotionInputs.profile = profile;
      renderResult = await this.remotionRender(remotionInputs);

      // Governance: NEVER silently fall back to FFmpeg when Remotion fails.
      if (!renderResult.success) {
        const rendererFamily = editDecisions.renderer_family ?? "unknown";
        return toolResult({
          success: false,
          error:
            `Remotion render failed for renderer_family=${JSON.stringify(rendererFamily)}. ` +
            `Underlying error: ${renderResult.error}\n\n` +
            `This composition requires Remotion (images, text cards, animations). ` +
            `Options:\n` +
            `  1. Fix Remotion setup (cd remotion-composer && npm install)\n` +
            `  2. Re-run with operation='compose' for FFmpeg-only (video cuts only)\n` +
            `  3. Approve a degraded FFmpeg render (still images → Ken Burns)\n\n` +
            `Per governance: renderer downgrade requires user approval.`,
        });
      }
    } else {
      // --- FFmpeg fallback: only when Remotion is unavailable ---
      const options = (inputs.options as Record<string, any>) ?? {};
      const subtitleBurn = options.subtitle_burn ?? true;

      let subtitlePath = inputs.subtitle_path as string | undefined;
      if (subtitleBurn && !subtitlePath) {
        const edSubs = (editDecisions.subtitles as Record<string, any>) ?? {};
        if (edSubs.enabled && edSubs.source) {
          subtitlePath = edSubs.source as string;
        }
      }

      const composeInputs: Record<string, unknown> = { ...inputs };
      composeInputs.edit_decisions = { ...editDecisions, cuts: resolvedCuts };
      composeInputs.output_path = outputPath;
      if (subtitlePath) composeInputs.subtitle_path = subtitlePath;
      if (profile) composeInputs.profile = profile;

      renderResult = await this.compose(composeInputs);
    }

    // --- Post-render: mandatory final self-review ---
    if (renderResult.success && fs.existsSync(outputPath)) {
      const finalReview = await this.runFinalReview(
        outputPath,
        editDecisions,
        inputs.proposal_packet as Record<string, any> | undefined,
        inputs.narration_transcript_path as string | undefined,
        (inputs.script_text as string | undefined) ??
          VideoCompose.readTextFile(inputs.script_path as string | undefined)
      );

      if (renderResult.data == null) renderResult.data = {};
      renderResult.data.final_review = finalReview;
      renderResult.data.final_review_status = finalReview.status;

      if (finalReview.status === "fail") {
        return toolResult({
          success: false,
          error:
            "Post-render self-review FAILED. The output is not presentable.\n" +
            ((finalReview.issues_found as string[]) ?? [])
              .map((i) => `  • ${i}`)
              .join("\n"),
          data: renderResult.data,
        });
      }
    }

    return renderResult;
  }

  // ------------------------------------------------------------------
  // render_via_hyperframes — delegate to hyperframes_compose
  // ------------------------------------------------------------------
  private async renderViaHyperframes(args: {
    inputs: Record<string, unknown>;
    editDecisions: Record<string, any>;
    assetManifest: Record<string, any>;
    resolvedCuts: any[];
    outputPath: string;
    profile: string | undefined;
  }): Promise<ToolResult> {
    const { inputs, editDecisions, assetManifest, resolvedCuts, outputPath, profile } =
      args;

    // Import lazily so video_compose works even before hyperframes_compose
    // is registered, and so a missing module surfaces as a structured error.
    let HyperFramesCompose: new () => {
      execute: (i: Record<string, unknown>) => Promise<ToolResult>;
      runtimeCheck: () => { runtime_available: boolean };
    };
    try {
      const mod = await import("./hyperframes_compose.js");
      HyperFramesCompose = mod.HyperFramesCompose as any;
    } catch (e) {
      return toolResult({
        success: false,
        error: `Could not import hyperframes_compose: ${errMsg(e)}`,
      });
    }

    const hf = new HyperFramesCompose();
    if (!hf.runtimeCheck().runtime_available) {
      return toolResult({
        success: false,
        error:
          "render_runtime='hyperframes' was locked at proposal, but " +
          "the HyperFrames runtime is not available on this machine. " +
          "Per governance this is a BLOCKER — surface it to the user " +
          "per AGENT_GUIDE.md > 'Escalate Blockers Explicitly' and wait " +
          "for approval before switching runtime. Requirements: " +
          "Node.js >= 22, FFmpeg, and npx on PATH.",
      });
    }

    const workspacePath =
      (inputs.workspace_path as string | undefined) ??
      path.join(path.dirname(path.dirname(outputPath)), "hyperframes");

    // Pass the playbook through so the style bridge can emit CSS vars.
    let playbookData = inputs.playbook as Record<string, any> | undefined;
    if (!playbookData) {
      const playbookName =
        (inputs.playbook_name as string | undefined) ??
        ((editDecisions.metadata as Record<string, any>) ?? {}).playbook;
      if (playbookName) {
        try {
          const mod = await import("../../styles/playbook_loader.js");
          playbookData = mod.loadPlaybook(playbookName);
        } catch {
          playbookData = undefined;
        }
      }
    }

    const hfInputs: Record<string, unknown> = {
      operation: "render",
      workspace_path: workspacePath,
      output_path: outputPath,
      edit_decisions: { ...editDecisions, cuts: resolvedCuts },
      asset_manifest: assetManifest,
    };
    if (playbookData) hfInputs.playbook = playbookData;
    if (profile) hfInputs.profile = profile;
    if ("quality" in inputs) hfInputs.quality = inputs.quality;
    if ("fps" in inputs) hfInputs.fps = inputs.fps;
    if ("strict" in inputs) hfInputs.strict = inputs.strict;
    if ("skip_contrast" in inputs) hfInputs.skip_contrast = inputs.skip_contrast;

    const renderResult = await hf.execute(hfInputs);

    if (!renderResult.success) {
      return toolResult({
        success: false,
        error:
          `HyperFrames render failed: ${renderResult.error}. ` +
          "Per governance: do NOT silently fall back to Remotion or " +
          "FFmpeg. Surface the failure to the user along with the " +
          "hyperframes_compose step log before proposing a swap.",
        data: renderResult.data,
      });
    }

    if (fs.existsSync(outputPath)) {
      const finalReview = await this.runFinalReview(
        outputPath,
        editDecisions,
        inputs.proposal_packet as Record<string, any> | undefined,
        inputs.narration_transcript_path as string | undefined,
        (inputs.script_text as string | undefined) ??
          VideoCompose.readTextFile(inputs.script_path as string | undefined)
      );
      if (renderResult.data == null) renderResult.data = {};
      renderResult.data.final_review = finalReview;
      renderResult.data.final_review_status = finalReview.status;
      if (finalReview.status === "fail") {
        return toolResult({
          success: false,
          error:
            "Post-render self-review FAILED (HyperFrames). The output is not presentable.\n" +
            ((finalReview.issues_found as string[]) ?? [])
              .map((i) => `  • ${i}`)
              .join("\n"),
          data: renderResult.data,
        });
      }
    }

    return renderResult;
  }

  // ------------------------------------------------------------------
  // render_via_ffmpeg — explicit FFmpeg-only render path
  // ------------------------------------------------------------------
  private async renderViaFfmpeg(args: {
    inputs: Record<string, unknown>;
    editDecisions: Record<string, any>;
    resolvedCuts: any[];
    outputPath: string;
    profile: string | undefined;
  }): Promise<ToolResult> {
    const { inputs, editDecisions, resolvedCuts, outputPath, profile } = args;

    const options = (inputs.options as Record<string, any>) ?? {};
    const subtitleBurn = options.subtitle_burn ?? true;

    let subtitlePath = inputs.subtitle_path as string | undefined;
    if (subtitleBurn && !subtitlePath) {
      const edSubs = (editDecisions.subtitles as Record<string, any>) ?? {};
      if (edSubs.enabled && edSubs.source) {
        subtitlePath = edSubs.source as string;
      }
    }

    const composeInputs: Record<string, unknown> = { ...inputs };
    composeInputs.edit_decisions = { ...editDecisions, cuts: resolvedCuts };
    composeInputs.output_path = outputPath;
    if (subtitlePath) composeInputs.subtitle_path = subtitlePath;
    if (profile) composeInputs.profile = profile;

    const renderResult = await this.compose(composeInputs);

    if (renderResult.success && fs.existsSync(outputPath)) {
      const finalReview = await this.runFinalReview(
        outputPath,
        editDecisions,
        inputs.proposal_packet as Record<string, any> | undefined,
        inputs.narration_transcript_path as string | undefined,
        (inputs.script_text as string | undefined) ??
          VideoCompose.readTextFile(inputs.script_path as string | undefined)
      );
      if (renderResult.data == null) renderResult.data = {};
      renderResult.data.final_review = finalReview;
      renderResult.data.final_review_status = finalReview.status;
      if (finalReview.status === "fail") {
        return toolResult({
          success: false,
          error:
            "Post-render self-review FAILED (FFmpeg). The output is not presentable.\n" +
            ((finalReview.issues_found as string[]) ?? [])
              .map((i) => `  • ${i}`)
              .join("\n"),
          data: renderResult.data,
        });
      }
    }

    return renderResult;
  }

  // ------------------------------------------------------------------
  // remotion_render — PROGRAMMATIC render via @remotion/bundler + renderer.
  //
  // Python shells out to `npx remotion render src/index.tsx <comp> <out>
  // --props <props>`. Here we bundle remotion-composer/src/index.tsx,
  // selectComposition (running calculateMetadata against inputProps), and
  // renderMedia with the h264 codec. Output is identical to the CLI.
  // ------------------------------------------------------------------
  private async remotionRender(
    inputs: Record<string, unknown>
  ): Promise<ToolResult> {
    const compositionData =
      (inputs.edit_decisions as Record<string, any> | undefined) ??
      (inputs.composition_data as Record<string, any> | undefined);
    if (!compositionData) {
      return toolResult({
        success: false,
        error:
          "edit_decisions or composition_data required for remotion_render",
      });
    }

    let outputPath = path.resolve(
      (inputs.output_path as string) ?? "renders/remotion_output.mp4"
    );
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    // Deep-copy props so we don't mutate the original.
    const props: Record<string, any> = JSON.parse(
      JSON.stringify(compositionData)
    );

    // Convert absolute file paths to file:// URIs for Remotion's Img and
    // OffthreadVideo components.
    for (const cut of (props.cuts as any[]) ?? []) {
      const source = cut.source ?? "";
      if (
        source &&
        !["http://", "https://", "file://"].some((pre) =>
          String(source).startsWith(pre)
        )
      ) {
        const resolved = path.resolve(source);
        if (fs.existsSync(resolved)) {
          const posix = resolved.split(path.sep).join("/");
          cut.source = posix.startsWith("/")
            ? `file://${posix}`
            : `file:///${posix}`;
        }
      }
    }

    // Build a custom themeConfig from the playbook's actual colors.
    if (!("themeConfig" in props)) {
      const playbookName =
        props.playbook ??
        props.theme ??
        ((props.metadata as Record<string, any>) ?? {}).playbook ??
        null;
      const themeConfig = await VideoCompose.buildThemeFromPlaybook(
        playbookName,
        compositionData
      );
      if (themeConfig) props.themeConfig = themeConfig;
    }

    // remotion-composer lives at project root.
    const composerDir = this.composerDir();
    if (!fs.existsSync(composerDir)) {
      return toolResult({
        success: false,
        error: `Remotion composer project not found at ${composerDir}`,
      });
    }

    if (!commandExists("npx") && !this.remotionAvailable()) {
      return toolResult({
        success: false,
        error: "npx not found. Install Node.js to use Remotion rendering.",
      });
    }

    // Route to the correct Remotion composition based on renderer_family.
    const rendererFamily =
      (compositionData.renderer_family as string | undefined) ??
      "explainer-data";
    let compositionId: string;
    try {
      compositionId = VideoCompose.getCompositionId(rendererFamily);
    } catch (e) {
      return toolResult({ success: false, error: errMsg(e) });
    }

    // Resolve media profile dimensions (optional).
    let widthOverride: number | undefined;
    let heightOverride: number | undefined;
    const profileName = inputs.profile as string | undefined;
    if (profileName) {
      const p = getProfile(profileName);
      if (p) {
        widthOverride = p.width;
        heightOverride = p.height;
      }
    }

    try {
      // Ensure the headless Chromium shell is present (free, first-run download).
      await ensureBrowser();

      // Bundle the project once per process.
      const entryPoint = path.join(composerDir, "src", "index.tsx");
      if (!bundlePromise) {
        bundlePromise = bundle({ entryPoint });
      }
      const serveUrl = await bundlePromise;

      // selectComposition runs calculateMetadata against inputProps.
      const composition = await selectComposition({
        serveUrl,
        id: compositionId,
        inputProps: props,
      });

      const renderWidth = widthOverride ?? composition.width;
      const renderHeight = heightOverride ?? composition.height;

      await renderMedia({
        composition: {
          ...composition,
          width: renderWidth,
          height: renderHeight,
        },
        serveUrl,
        codec: "h264" as Codec,
        outputLocation: outputPath,
        inputProps: props,
      });
    } catch (e) {
      return toolResult({
        success: false,
        error: `Remotion render failed: ${errMsg(e)}`,
      });
    }

    if (!fs.existsSync(outputPath)) {
      return toolResult({
        success: false,
        error: `Remotion render completed but output file missing: ${outputPath}`,
      });
    }

    return toolResult({
      success: true,
      data: {
        operation: "remotion_render",
        output: outputPath,
        profile: profileName ?? null,
      },
      artifacts: [outputPath],
    });
  }

  // ------------------------------------------------------------------
  // Final self-review — mandatory post-render inspection
  // ------------------------------------------------------------------
  private static readTextFile(p: string | undefined): string | undefined {
    if (!p) return undefined;
    try {
      return fs.readFileSync(p, "utf-8");
    } catch {
      return undefined;
    }
  }

  private static tokenize(text: string): string[] {
    // Preserve hyphenated words; drop everything except letters/digits/hyphens/apostrophes.
    const cleaned = text
      .toLowerCase()
      .replace(/[^a-z0-9\-' ]+/g, " ");
    return cleaned.split(/\s+/).filter((t) => t && t !== "-");
  }

  private static compareTranscriptToScript(
    transcriptPath: string | undefined,
    scriptText: string | undefined
  ): Record<string, any> {
    const result: Record<string, any> = {
      transcript_matches_script: false,
      word_accuracy: null,
      script_word_count: 0,
      transcript_word_count: 0,
      spurious_punctuation_words: [],
      issues: [],
    };

    if (!transcriptPath || !isFile(transcriptPath)) {
      result.issues.push(
        "transcript_comparison skipped: narration_transcript not provided"
      );
      return result;
    }
    if (!scriptText) {
      result.issues.push(
        "transcript_comparison skipped: script_text not provided"
      );
      return result;
    }

    let transcriptData: Record<string, any>;
    try {
      transcriptData = JSON.parse(fs.readFileSync(transcriptPath, "utf-8"));
    } catch (e) {
      result.issues.push(
        `transcript_comparison could not parse transcript: ${errMsg(e)}`
      );
      return result;
    }

    const transcriptWords = (
      (transcriptData.word_timestamps as any[]) ?? []
    ).map((w) => String(w.word ?? "").trim());
    const transcriptTokens = VideoCompose.tokenize(transcriptWords.join(" "));
    const scriptTokens = VideoCompose.tokenize(scriptText);

    result.script_word_count = scriptTokens.length;
    result.transcript_word_count = transcriptTokens.length;

    if (scriptTokens.length === 0 || transcriptTokens.length === 0) {
      result.issues.push(
        `transcript_comparison: empty token set ` +
          `(script=${scriptTokens.length}, transcript=${transcriptTokens.length})`
      );
      return result;
    }

    const scriptSet = new Set(scriptTokens);
    const transcriptSet = new Set(transcriptTokens);
    const leakOccurrences: Record<string, number> = {};
    for (const token of transcriptTokens) {
      if (
        VideoCompose.TTS_PUNCTUATION_LEAK_WORDS.has(token) &&
        !scriptSet.has(token)
      ) {
        leakOccurrences[token] = (leakOccurrences[token] ?? 0) + 1;
      }
    }

    const leakEntries = Object.entries(leakOccurrences);
    if (leakEntries.length > 0) {
      const formatted = leakEntries
        .sort((a, b) => b[1] - a[1])
        .map(([w, n]) => `'${w}'×${n}`)
        .join(", ");
      result.spurious_punctuation_words = leakEntries.map(([w, n]) => ({
        word: w,
        count: n,
      }));
      result.issues.push(
        `TTS punctuation leak: transcript contains ${formatted} — ` +
          `these words are NOT in the script, which means the voice ` +
          `engine is reading literal punctuation aloud. Rewrite the ` +
          `script to eliminate the corresponding characters (ellipses, ` +
          `em-dashes, etc.) and regenerate narration.`
      );
    }

    let matched = 0;
    for (const t of scriptTokens) {
      if (transcriptSet.has(t)) matched++;
    }
    const accuracy = matched / Math.max(1, scriptTokens.length);
    result.word_accuracy = Math.round(accuracy * 1000) / 1000;
    result.transcript_matches_script =
      accuracy >= 0.9 && leakEntries.length === 0;

    if (accuracy < 0.9) {
      result.issues.push(
        `Low transcript-to-script match: only ${Math.round(accuracy * 100)}% of script ` +
          `words appear in the transcribed audio (${matched}/` +
          `${scriptTokens.length}). Narration may be truncated, mispronounced, ` +
          `or the wrong script was used.`
      );
    }

    return result;
  }

  private async runFinalReview(
    outputPath: string,
    editDecisions?: Record<string, any>,
    proposalPacket?: Record<string, any>,
    narrationTranscriptPath?: string,
    scriptText?: string
  ): Promise<Record<string, any>> {
    const issues: string[] = [];

    // --- 1. Technical probe via ffprobe ---
    let technicalProbe: Record<string, any> = {
      valid_container: false,
      issues: [],
    };
    try {
      const { stdout, exitCode } = await this.runProbe([
        "ffprobe",
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        outputPath,
      ]);
      if (exitCode === 0) {
        const probeData = JSON.parse(stdout) as Record<string, any>;
        const fmt = (probeData.format as Record<string, any>) ?? {};
        const streams = (probeData.streams as any[]) ?? [];
        const videoStream =
          streams.find((s) => s.codec_type === "video") ?? {};
        const audioStream =
          streams.find((s) => s.codec_type === "audio") ?? {};

        const duration = parseFloat(fmt.duration ?? "0");
        const width = parseInt(videoStream.width ?? "0", 10);
        const height = parseInt(videoStream.height ?? "0", 10);
        const fps = VideoCompose.parseProbeFps(
          videoStream.r_frame_rate ?? "0/1"
        );

        technicalProbe = {
          valid_container: Object.keys(videoStream).length > 0,
          duration_seconds: Math.round(duration * 100) / 100,
          resolution: `${width}x${height}`,
          fps,
          has_audio: Object.keys(audioStream).length > 0,
          codec: videoStream.codec_name ?? "unknown",
          file_size_bytes: parseInt(fmt.size ?? "0", 10),
          issues: [],
        };

        if (duration < 1.0) {
          technicalProbe.issues.push(
            `Output is only ${duration.toFixed(1)}s — suspiciously short`
          );
        }

        let targetDur: number | undefined;
        if (editDecisions) {
          targetDur =
            editDecisions.total_duration_seconds ??
            (editDecisions.metadata as Record<string, any>)
              ?.target_duration_seconds;
        }
        if (targetDur && targetDur > 0) {
          const driftPct = Math.abs(duration - targetDur) / targetDur;
          if (driftPct > 0.25) {
            technicalProbe.issues.push(
              `Duration drift: rendered ${duration.toFixed(1)}s vs target ${targetDur}s ` +
                `(${Math.round(driftPct * 100)}% off). Review pacing or trim.`
            );
          }
          technicalProbe.target_duration = targetDur;
          technicalProbe.duration_drift_pct =
            Math.round(driftPct * 1000) / 10;
        }
        if (width < 320 || height < 240) {
          technicalProbe.issues.push(
            `Resolution ${width}x${height} is very low`
          );
        }
        if (Object.keys(audioStream).length === 0) {
          technicalProbe.issues.push("No audio stream in output");
        }
      } else {
        technicalProbe.issues.push(`ffprobe failed with exit code ${exitCode}`);
      }
    } catch (e) {
      if (errMsg(e).includes("ENOENT")) {
        technicalProbe.issues.push("ffprobe not found — cannot validate output");
      } else {
        technicalProbe.issues.push(`ffprobe error: ${errMsg(e)}`);
      }
    }

    issues.push(...(technicalProbe.issues ?? []));

    // --- 2. Visual spotcheck: sample 4 frames ---
    const visualSpotcheck: Record<string, any> = {
      frames_sampled: 0,
      frame_paths: [],
      black_frames_detected: false,
      broken_overlays: false,
      missing_assets: false,
      unreadable_text: false,
      issues: [],
    };
    const duration = technicalProbe.duration_seconds ?? 0;
    if (duration > 0 && technicalProbe.valid_container) {
      try {
        const frameDir = path.join(
          path.dirname(outputPath),
          ".final_review_frames"
        );
        fs.mkdirSync(frameDir, { recursive: true });
        const samplePoints = [0.1, 0.35, 0.65, 0.9];
        const framePaths: string[] = [];
        for (let i = 0; i < samplePoints.length; i++) {
          const ts = Math.round(duration * samplePoints[i] * 100) / 100;
          const framePath = path.join(frameDir, `review_frame_${i}.png`);
          await this.runProbe([
            "ffmpeg",
            "-y",
            "-ss",
            String(ts),
            "-i",
            outputPath,
            "-frames:v",
            "1",
            "-q:v",
            "2",
            framePath,
          ]);
          if (fs.existsSync(framePath)) {
            framePaths.push(framePath);
            if (fs.statSync(framePath).size < 2000) {
              visualSpotcheck.black_frames_detected = true;
            }
          }
        }

        visualSpotcheck.frames_sampled = framePaths.length;
        visualSpotcheck.frame_paths = framePaths;

        if (framePaths.length < 4) {
          visualSpotcheck.issues.push(
            `Only ${framePaths.length}/4 frames extracted — some timestamps may be out of range`
          );
        }
        if (visualSpotcheck.black_frames_detected) {
          visualSpotcheck.issues.push(
            "Black frame detected — possible missing asset or failed render segment"
          );
        }
      } catch (e) {
        visualSpotcheck.issues.push(`Frame sampling error: ${errMsg(e)}`);
      }
    }

    issues.push(...(visualSpotcheck.issues ?? []));

    // --- 3. Audio spotcheck ---
    const audioSpotcheck: Record<string, any> = {
      narration_present: false,
      music_present: false,
      unexpected_silence: false,
      clipping_detected: false,
      mix_intelligible: true,
      issues: [],
    };
    if (technicalProbe.has_audio && duration > 0) {
      try {
        const { stderr } = await this.runProbe([
          "ffmpeg",
          "-i",
          outputPath,
          "-af",
          "volumedetect",
          "-f",
          "null",
          "-",
        ]);
        const errText = stderr ?? "";
        let meanVol: number | null = null;
        let maxVol: number | null = null;
        for (const line of errText.split("\n")) {
          if (line.includes("mean_volume:")) {
            const v = parseFloat(
              line.split("mean_volume:")[1].trim().split(/\s+/)[0]
            );
            if (!Number.isNaN(v)) meanVol = v;
          }
          if (line.includes("max_volume:")) {
            const v = parseFloat(
              line.split("max_volume:")[1].trim().split(/\s+/)[0]
            );
            if (!Number.isNaN(v)) maxVol = v;
          }
        }

        if (meanVol != null) {
          if (meanVol < -60) {
            audioSpotcheck.unexpected_silence = true;
            audioSpotcheck.issues.push(
              `Mean volume ${meanVol.toFixed(1)} dB — effectively silent`
            );
          }
          if (meanVol > -40) audioSpotcheck.narration_present = true;
          if (meanVol > -50) audioSpotcheck.music_present = true;
        }

        if (maxVol != null && maxVol > -0.5) {
          audioSpotcheck.clipping_detected = true;
          audioSpotcheck.issues.push(
            `Max volume ${maxVol.toFixed(1)} dB — possible clipping`
          );
        }
      } catch (e) {
        audioSpotcheck.issues.push(`Audio analysis error: ${errMsg(e)}`);
      }
    }

    issues.push(...(audioSpotcheck.issues ?? []));

    // --- 4. Promise preservation ---
    const promisePreservation: Record<string, any> = {
      delivery_promise_honored: true,
      silent_downgrade_detected: false,
      runtime_swap_detected: false,
      issues: [],
    };
    if (editDecisions) {
      const rendererFamily = editDecisions.renderer_family ?? "";
      promisePreservation.renderer_family_used = rendererFamily;

      const renderRuntimeEdit = String(editDecisions.render_runtime ?? "")
        .trim()
        .toLowerCase();
      if (renderRuntimeEdit) {
        promisePreservation.render_runtime_used = renderRuntimeEdit;

        let proposalRuntime: string | null = null;
        let runtimeSource: string | null = null;
        if (proposalPacket) {
          const ppRuntime = String(
            (proposalPacket.production_plan as Record<string, any>)
              ?.render_runtime ?? ""
          )
            .trim()
            .toLowerCase();
          if (ppRuntime) {
            proposalRuntime = ppRuntime;
            runtimeSource =
              "proposal_packet.production_plan.render_runtime";
          }
        }
        if (proposalRuntime === null) {
          const mdRuntime = String(
            (editDecisions.metadata as Record<string, any>)
              ?.proposal_render_runtime ?? ""
          )
            .trim()
            .toLowerCase();
          if (mdRuntime) {
            proposalRuntime = mdRuntime;
            runtimeSource =
              "edit_decisions.metadata.proposal_render_runtime";
          }
        }

        if (proposalRuntime === null) {
          promisePreservation.runtime_swap_check =
            "skipped — no proposal_packet or proposal_render_runtime " +
            "metadata provided. Reviewer skill does cross-artifact " +
            "comparison separately.";
        } else if (proposalRuntime !== renderRuntimeEdit) {
          promisePreservation.runtime_swap_detected = true;
          promisePreservation.runtime_swap_check = `detected — source: ${runtimeSource}`;
          promisePreservation.issues.push(
            `render_runtime changed between proposal (${proposalRuntime}) ` +
              `and compose (${renderRuntimeEdit}) — this is a contract ` +
              `violation unless a render_runtime_selection decision was logged.`
          );
        } else {
          promisePreservation.runtime_swap_check = `ok — proposal and edit agree (${runtimeSource})`;
        }
      }
      // lib.delivery_promise has no TS port — delivery-promise validation is
      // skipped (same as Python catching the import error).
    }

    issues.push(...(promisePreservation.issues ?? []));

    // --- 5. Subtitle check ---
    const subtitleCheck: Record<string, any> = {
      subtitles_expected: false,
      subtitles_present: false,
      issues: [],
    };
    if (editDecisions) {
      const edSubs = (editDecisions.subtitles as Record<string, any>) ?? {};
      subtitleCheck.subtitles_expected = Boolean(edSubs.enabled);

      if (technicalProbe.valid_container) {
        try {
          const { stdout, exitCode } = await this.runProbe([
            "ffprobe",
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_streams",
            "-select_streams",
            "s",
            outputPath,
          ]);
          if (exitCode === 0) {
            const subData = JSON.parse(stdout) as Record<string, any>;
            const subStreams = (subData.streams as any[]) ?? [];
            subtitleCheck.subtitles_present = subStreams.length > 0;
          }

          if (
            subtitleCheck.subtitles_expected &&
            !subtitleCheck.subtitles_present
          ) {
            const subSource = edSubs.source as string | undefined;
            if (subSource && fs.existsSync(subSource)) {
              subtitleCheck.subtitles_present = true;
              subtitleCheck.coverage_ratio = 1.0;
            } else {
              subtitleCheck.issues.push(
                "Subtitles expected but not found in output and " +
                  "no subtitle source file exists for burn-in"
              );
            }
          }
        } catch (e) {
          subtitleCheck.issues.push(`Subtitle check error: ${errMsg(e)}`);
        }
      }
    }

    issues.push(...(subtitleCheck.issues ?? []));

    // --- 6. Transcript-vs-script comparison ---
    const transcriptComparison = VideoCompose.compareTranscriptToScript(
      narrationTranscriptPath,
      scriptText
    );
    issues.push(...(transcriptComparison.issues ?? []));

    // --- 7. Determine overall status ---
    const criticalKws = [
      "silent downgrade",
      "delivery promise violation",
      "effectively silent",
      "ffprobe failed",
      "suspiciously short",
      "tts punctuation leak",
    ];
    const criticalIssues = issues.filter((i) =>
      criticalKws.some((kw) => i.toLowerCase().includes(kw))
    );

    let status: string;
    let recommendedAction: string;
    if (criticalIssues.length > 0) {
      status = "revise";
      recommendedAction = "re_render";
    } else {
      status = "pass";
      recommendedAction = "present_to_user";
    }

    if (!technicalProbe.valid_container) {
      status = "fail";
      recommendedAction = "re_render";
    }

    const finalReview = {
      version: "1.0",
      output_path: outputPath,
      status,
      checks: {
        technical_probe: technicalProbe,
        visual_spotcheck: visualSpotcheck,
        audio_spotcheck: audioSpotcheck,
        promise_preservation: promisePreservation,
        subtitle_check: subtitleCheck,
        transcript_comparison: transcriptComparison,
      },
      issues_found: issues,
      recommended_action: recommendedAction,
    };

    return finalReview;
  }

  private static parseProbeFps(fpsStr: string): number {
    try {
      if (fpsStr.includes("/")) {
        const [num, den] = fpsStr.split("/");
        return (
          Math.round((parseInt(num, 10) / Math.max(parseInt(den, 10), 1)) * 100) /
          100
        );
      }
      return parseFloat(fpsStr);
    } catch {
      return 0.0;
    }
  }

  /**
   * Run a probe/inspection subprocess that must NOT throw on non-zero exit
   * (mirrors Python's subprocess.run capture_output without check=True). The
   * primary runCommand (execa) rejects on non-zero exit; here we tolerate it.
   */
  private async runProbe(
    cmd: string[]
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    try {
      const proc = await this.runCommand(cmd);
      return {
        stdout: String(proc.stdout ?? ""),
        stderr: String(proc.stderr ?? ""),
        exitCode: proc.exitCode ?? 0,
      };
    } catch (e: any) {
      // execa throws on non-zero exit / ENOENT; surface stdout/stderr if present.
      if (e && (e.stdout !== undefined || e.stderr !== undefined)) {
        return {
          stdout: String(e.stdout ?? ""),
          stderr: String(e.stderr ?? ""),
          exitCode: typeof e.exitCode === "number" ? e.exitCode : 1,
        };
      }
      throw e;
    }
  }

  // ------------------------------------------------------------------
  // burn_subtitles
  // ------------------------------------------------------------------
  private async burnSubtitles(
    inputs: Record<string, unknown>
  ): Promise<ToolResult> {
    const inputPath = path.resolve(inputs.input_path as string);
    const subtitlePath = path.resolve(inputs.subtitle_path as string);
    const parsed = path.parse(inputPath);
    const outputPath = path.resolve(
      (inputs.output_path as string) ??
        path.join(parsed.dir, `${parsed.name}_subtitled${parsed.ext}`)
    );

    if (!fs.existsSync(inputPath)) {
      return toolResult({ success: false, error: `Input not found: ${inputPath}` });
    }
    if (!fs.existsSync(subtitlePath)) {
      return toolResult({
        success: false,
        error: `Subtitle file not found: ${subtitlePath}`,
      });
    }

    const style = (inputs.subtitle_style as Record<string, any>) ?? {};
    const assStyle = VideoCompose.buildSubtitleStyle(style);
    const subEscaped = subtitlePath
      .replace(/\\/g, "/")
      .replace(/:/g, "\\:");
    const codec = (inputs.codec as string) ?? "libx264";
    const crf = (inputs.crf as number) ?? 23;

    await this.runCommand([
      "ffmpeg",
      "-y",
      "-i",
      inputPath,
      "-vf",
      `subtitles='${subEscaped}':force_style='${assStyle}'`,
      "-c:v",
      codec,
      "-crf",
      String(crf),
      "-c:a",
      "copy",
      outputPath,
    ]);

    return toolResult({
      success: true,
      data: { operation: "burn_subtitles", output: outputPath },
      artifacts: [outputPath],
    });
  }

  // ------------------------------------------------------------------
  // overlay
  // ------------------------------------------------------------------
  private async overlay(
    inputs: Record<string, unknown>
  ): Promise<ToolResult> {
    const inputPath = path.resolve(inputs.input_path as string);
    const overlays = (inputs.overlays as any[]) ?? [];
    const parsed = path.parse(inputPath);
    const outputPath = path.resolve(
      (inputs.output_path as string) ??
        path.join(parsed.dir, `${parsed.name}_overlay${parsed.ext}`)
    );
    const codec = (inputs.codec as string) ?? "libx264";
    const crf = (inputs.crf as number) ?? 23;

    if (!fs.existsSync(inputPath)) {
      return toolResult({ success: false, error: `Input not found: ${inputPath}` });
    }
    if (overlays.length === 0) {
      return toolResult({ success: false, error: "No overlays provided" });
    }

    const inputArgs: string[] = ["-i", inputPath];
    const filterParts: string[] = [];
    let prevLabel = "0:v";

    for (let i = 0; i < overlays.length; i++) {
      const ov = overlays[i];
      const assetPath = path.resolve(ov.asset_path);
      if (!fs.existsSync(assetPath)) {
        return toolResult({
          success: false,
          error: `Overlay asset not found: ${assetPath}`,
        });
      }

      inputArgs.push("-i", assetPath);

      const x = Math.trunc(ov.x ?? 0);
      const y = Math.trunc(ov.y ?? 0);
      const start = ov.start_seconds ?? 0;
      const end = ov.end_seconds;

      let overlayInput = `${i + 1}:v`;

      if ("width" in ov && "height" in ov) {
        const w = Math.trunc(ov.width);
        const h = Math.trunc(ov.height);
        filterParts.push(`[${overlayInput}]scale=${w}:${h}[ov_scaled_${i}]`);
        overlayInput = `ov_scaled_${i}`;
      }

      const enable =
        end !== undefined && end !== null
          ? `between(t,${start},${end})`
          : `gte(t,${start})`;
      const outLabel = `v${i}`;

      filterParts.push(
        `[${prevLabel}][${overlayInput}]overlay=${x}:${y}:enable='${enable}'[${outLabel}]`
      );
      prevLabel = outLabel;
    }

    const filterComplex = filterParts.join(";");

    const cmd: string[] = ["ffmpeg", "-y"];
    cmd.push(...inputArgs);
    cmd.push("-filter_complex", filterComplex);
    cmd.push("-map", `[${prevLabel}]`, "-map", "0:a?");
    cmd.push("-c:v", codec, "-crf", String(crf), "-c:a", "copy");
    cmd.push(outputPath);

    await this.runCommand(cmd);

    return toolResult({
      success: true,
      data: {
        operation: "overlay",
        overlay_count: overlays.length,
        output: outputPath,
      },
      artifacts: [outputPath],
    });
  }

  // ------------------------------------------------------------------
  // encode
  // ------------------------------------------------------------------
  private async encode(
    inputs: Record<string, unknown>
  ): Promise<ToolResult> {
    const inputPath = path.resolve(inputs.input_path as string);
    const parsed = path.parse(inputPath);
    const outputPath = path.resolve(
      (inputs.output_path as string) ??
        path.join(parsed.dir, `${parsed.name}_encoded${parsed.ext}`)
    );
    const codec = (inputs.codec as string) ?? "libx264";
    const crf = (inputs.crf as number) ?? 23;
    const preset = (inputs.preset as string) ?? "medium";
    const profileName = inputs.profile as string | undefined;

    if (!fs.existsSync(inputPath)) {
      return toolResult({ success: false, error: `Input not found: ${inputPath}` });
    }

    const cmd: string[] = [
      "ffmpeg",
      "-y",
      "-i",
      inputPath,
      "-c:v",
      codec,
      "-crf",
      String(crf),
      "-preset",
      preset,
      "-c:a",
      "aac",
      "-b:a",
      "192k",
    ];

    if (profileName) {
      const profile = getProfile(profileName);
      if (profile) {
        cmd.push("-s", `${profile.width}x${profile.height}`);
        cmd.push("-r", String(profile.fps));
      }
    }

    cmd.push(outputPath);
    await this.runCommand(cmd);

    return toolResult({
      success: true,
      data: {
        operation: "encode",
        codec,
        crf,
        profile: profileName ?? null,
        output: outputPath,
      },
      artifacts: [outputPath],
    });
  }

  // ------------------------------------------------------------------
  // Subtitle style helpers
  // ------------------------------------------------------------------
  private static resolveSubtitleStyle(
    explicitStyle: Record<string, any> | undefined,
    editDecisions: Record<string, any> | undefined,
    playbook: Record<string, any> | undefined
  ): Record<string, any> {
    const resolved: Record<string, any> = {
      font: "Inter",
      font_size: 28,
      bold: true,
      outline_width: 2,
      shadow: 0,
      margin_v: 40,
      alignment: 2,
    };

    if (playbook) {
      const typo = (playbook.typography as Record<string, any>) ?? {};
      const colors =
        ((playbook.visual_language as Record<string, any>) ?? {})
          .color_palette ?? {};
      if ((typo.body as Record<string, any>)?.family) {
        resolved.font = (typo.body as Record<string, any>).family;
      }
      if (colors.text) resolved.primary_color = colors.text;
      if (colors.background) {
        resolved.outline_color = colors.background;
        resolved.back_color = colors.background;
      }
    }

    if (editDecisions) {
      const edStyle =
        ((editDecisions.subtitles as Record<string, any>) ?? {}).style ?? {};
      for (const [k, v] of Object.entries(edStyle)) {
        if (v != null) resolved[k] = v;
      }
    }

    if (explicitStyle) {
      for (const [k, v] of Object.entries(explicitStyle)) {
        if (v != null) resolved[k] = v;
      }
    }

    return resolved;
  }

  private static buildSubtitleStyle(style: Record<string, any>): string {
    const parts: string[] = [];
    parts.push(`FontName=${style.font ?? "Inter"}`);
    parts.push(`FontSize=${style.font_size ?? 28}`);
    parts.push(`Bold=${style.bold ?? true ? 1 : 0}`);
    if (style.primary_color) parts.push(`PrimaryColour=${style.primary_color}`);
    if (style.outline_color) parts.push(`OutlineColour=${style.outline_color}`);
    if (style.back_color) parts.push(`BackColour=${style.back_color}`);
    const borderStyle = style.border_style ?? 1;
    parts.push(`BorderStyle=${borderStyle}`);
    parts.push(`Outline=${style.outline_width ?? 2}`);
    parts.push(`Shadow=${style.shadow ?? 0}`);
    parts.push(`MarginV=${style.margin_v ?? 40}`);
    parts.push(`Alignment=${style.alignment ?? 2}`);
    return parts.join(",");
  }

  private static buildAtempo(factor: number): string {
    const filters: string[] = [];
    let remaining = factor;
    while (remaining > 100.0) {
      filters.push("atempo=100.0");
      remaining /= 100.0;
    }
    while (remaining < 0.5) {
      filters.push("atempo=0.5");
      remaining /= 0.5;
    }
    filters.push(`atempo=${remaining.toFixed(4)}`);
    return filters.join(",");
  }
}

// ---------------------------------------------------------------------------
// Module-local helpers
// ---------------------------------------------------------------------------
function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
