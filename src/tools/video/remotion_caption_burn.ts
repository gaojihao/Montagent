/**
 * Remotion caption burn tool — runtime-specific (Remotion-only).
 *
 * TypeScript port of tools/video/remotion_caption_burn.py. Renders animated
 * word-by-word captions onto a talking-head video using the Remotion
 * CaptionOverlay component, falling back to FFmpeg subtitle burning if Remotion
 * is not available.
 *
 * Parity notes vs. Python:
 *  - name/capability/provider/tier/stability/dependencies/schema and the result
 *    data fields all match verbatim.
 *  - Word-caption conversion from segments and from SRT (including the
 *    punctuation-stripping correction logic and the trailing-punctuation
 *    preservation quirk) matches verbatim.
 *  - The Remotion path SHELLS OUT to `npx remotion render` exactly as Python
 *    does. The TalkingHead composition takes CLI-only flags (--props relative to
 *    root, --width/--height/--fps, --frames=0-N, --codec/--crf, --output) that
 *    the programmatic Explainer demo renderer (src/remotion/render.ts) does not
 *    accept, so the CLI invocation is preserved for behavioral parity.
 *  - DEVIATION: Python chose "npx.cmd" on win32; execa resolves Windows .cmd
 *    wrappers natively (see base_tool.runCommand), so we pass "npx" on all
 *    platforms. Behavior is identical.
 *  - The FFmpeg fallback's temp-SRT generation, the subtitles force_style
 *    string, and the SRT path escaping (\\ -> / and : -> \:) match verbatim.
 */
import fs from "node:fs";
import path from "node:path";
import {
  BaseTool,
  Determinism,
  ExecutionMode,
  PROJECT_ROOT,
  ResourceProfile,
  ToolResult,
  ToolStability,
  ToolTier,
  commandExists,
  toolResult,
} from "../base_tool.js";

interface Word {
  word: string;
  start: number;
  end: number;
}

interface Segment {
  words?: Word[];
  text?: string;
  start?: number;
  end?: number;
}

interface WordCaption {
  word: string;
  startMs: number;
  endMs: number;
}

export class RemotionCaptionBurn extends BaseTool {
  override name = "remotion_caption_burn";
  override version = "0.1.0";
  override tier = ToolTier.CORE;
  override capability = "subtitle";
  override provider = "remotion";
  override stability = ToolStability.EXPERIMENTAL;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;

  override dependencies = ["cmd:ffmpeg", "cmd:ffprobe"];
  override install_instructions =
    "Remotion (optional, preferred): npm install in remotion-composer/\n" +
    "FFmpeg (required for fallback): https://ffmpeg.org/download.html";
  override agent_skills = ["remotion-best-practices", "ffmpeg"];

  override capabilities = [
    "burn_remotion_captions",
    "burn_ffmpeg_captions_fallback",
  ];

  override input_schema = {
    type: "object",
    required: ["input_path", "output_path"],
    properties: {
      input_path: {
        type: "string",
        description: "Path to the input video (enhanced talking-head footage).",
      },
      output_path: {
        type: "string",
        description: "Path for the output video with captions burned in.",
      },
      segments: {
        type: "array",
        description:
          "Word-level transcript segments from transcriber tool. " +
          "Each segment has 'words' array with {word, start, end}.",
      },
      srt_path: {
        type: "string",
        description:
          "Path to an SRT file. Used as an alternative to segments. " +
          "If both provided, segments take priority.",
      },
      words_per_page: {
        type: "integer",
        default: 4,
        description: "Words shown at once in the caption overlay.",
      },
      font_size: {
        type: "integer",
        default: 52,
        description: "Font size for captions.",
      },
      highlight_color: {
        type: "string",
        default: "#22D3EE",
        description: "Highlight color for the active word (hex).",
      },
      corrections: {
        type: "object",
        description:
          "Dictionary of word corrections for common misrecognitions. " +
          "Keys are the wrong word (case-insensitive), values are the " +
          'correct replacement. Example: {"cloud": "Claude"}.',
      },
      overlays: {
        type: "array",
        description:
          "Array of overlay objects to render on top of the video. " +
          "Each overlay has: type (text_card, stat_card, callout, " +
          "comparison, bar_chart, line_chart, pie_chart, kpi_grid, " +
          "hero_title, section_title, stat_reveal), in_seconds, " +
          "out_seconds, position (lower_third, upper_third, " +
          "left_panel, right_panel, full_overlay), and component-" +
          "specific props (text, stat, chartData, etc.). " +
          "See asset_manifest overlays from the asset-director.",
      },
      force_ffmpeg: {
        type: "boolean",
        default: false,
        description: "Force FFmpeg fallback even if Remotion is available.",
      },
    },
  };

  override resource_profile: ResourceProfile = {
    cpu_cores: 4,
    ram_mb: 2048,
    vram_mb: 0,
    disk_mb: 500,
    network_required: false,
  };
  override idempotency_key_fields = ["input_path", "segments", "srt_path"];
  override side_effects = ["writes captioned video to output_path"];
  override user_visible_verification = [
    "Play the output video and verify captions appear at the bottom of the frame",
    "Check that the active word is highlighted in the specified color",
    "Verify face is not occluded by caption text",
  ];

  // ------------------------------------------------------------------ //
  //  Remotion detection
  // ------------------------------------------------------------------ //

  /** Find the remotion-composer directory relative to the repo. */
  private _findRemotionRoot(): string | null {
    const candidates = [
      path.join(process.cwd(), "remotion-composer"),
      path.join(PROJECT_ROOT, "remotion-composer"),
    ];
    for (const p of candidates) {
      if (
        isDir(p) &&
        fs.existsSync(path.join(p, "package.json")) &&
        isDir(path.join(p, "node_modules"))
      ) {
        return p;
      }
    }
    return null;
  }

  private _remotionAvailable(): boolean {
    return commandExists("npx") && this._findRemotionRoot() !== null;
  }

  // ------------------------------------------------------------------ //
  //  Word caption conversion
  // ------------------------------------------------------------------ //

  /** Convert transcriber segments to [{word, startMs, endMs}, ...]. */
  private _segmentsToWordCaptions(
    segments: Segment[],
    corrections?: Record<string, string>
  ): WordCaption[] {
    const captions: WordCaption[] = [];
    const corr: Record<string, string> = {};
    for (const [k, v] of Object.entries(corrections ?? {})) {
      corr[k.toLowerCase()] = v;
    }

    for (const seg of segments) {
      const words = seg.words ?? [];
      if (words.length) {
        for (const w of words) {
          const raw = w.word.trim();
          const lookup = strip(raw.toLowerCase(), ".,!?;:");
          const fixedBase = lookup in corr ? corr[lookup] : raw;
          let fixed = fixedBase;
          // Preserve trailing punctuation from original
          let trailing = "";
          if (raw && ".,!?;:".includes(raw[raw.length - 1]!)) {
            trailing = raw[raw.length - 1]!;
          }
          if (fixed !== raw && !fixed.endsWith(trailing)) {
            fixed = fixed + trailing;
          }
          captions.push({
            word: fixed,
            startMs: Math.trunc(w.start * 1000),
            endMs: Math.trunc(w.end * 1000),
          });
        }
      } else if ("text" in seg) {
        const textWords = (seg.text as string).trim().split(/\s+/);
        const dur = (seg.end as number) - (seg.start as number);
        const perWord = dur / Math.max(textWords.length, 1);
        textWords.forEach((tw, i) => {
          const lookup = strip(tw.toLowerCase(), ".,!?;:");
          const fixed = lookup in corr ? corr[lookup] : tw;
          captions.push({
            word: fixed,
            startMs: Math.trunc(((seg.start as number) + i * perWord) * 1000),
            endMs: Math.trunc(((seg.start as number) + (i + 1) * perWord) * 1000),
          });
        });
      }
    }
    return captions;
  }

  /** Parse SRT file into word captions. */
  private _srtToWordCaptions(
    srtPath: string,
    corrections?: Record<string, string>
  ): WordCaption[] {
    const content = fs.readFileSync(srtPath, { encoding: "utf-8" });
    const blocks = content.trim().split(/\n\n+/);
    const corr: Record<string, string> = {};
    for (const [k, v] of Object.entries(corrections ?? {})) {
      corr[k.toLowerCase()] = v;
    }
    const captions: WordCaption[] = [];

    for (const block of blocks) {
      const lines = block.trim().split("\n");
      if (lines.length < 3) {
        continue;
      }
      const m = lines[1]!.match(
        /(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/
      );
      if (!m) {
        continue;
      }
      const startMs =
        parseInt(m[1]!, 10) * 3600000 +
        parseInt(m[2]!, 10) * 60000 +
        parseInt(m[3]!, 10) * 1000 +
        parseInt(m[4]!, 10);
      const endMs =
        parseInt(m[5]!, 10) * 3600000 +
        parseInt(m[6]!, 10) * 60000 +
        parseInt(m[7]!, 10) * 1000 +
        parseInt(m[8]!, 10);
      const text = lines.slice(2).join(" ").trim();
      const words = text.split(/\s+/);
      const perWord = (endMs - startMs) / Math.max(words.length, 1);
      words.forEach((w, i) => {
        const lookup = strip(w.toLowerCase(), ".,!?;:");
        const fixed = lookup in corr ? corr[lookup] : w;
        captions.push({
          word: fixed,
          startMs: Math.trunc(startMs + i * perWord),
          endMs: Math.trunc(startMs + (i + 1) * perWord),
        });
      });
    }
    return captions;
  }

  // ------------------------------------------------------------------ //
  //  Remotion render
  // ------------------------------------------------------------------ //

  private async _renderRemotion(
    inputPath: string,
    outputPath: string,
    captions: WordCaption[],
    wordsPerPage: number,
    fontSize: number,
    highlightColor: string,
    overlays?: Record<string, unknown>[]
  ): Promise<ToolResult> {
    const root = this._findRemotionRoot();
    if (root === null) {
      return toolResult({ success: false, error: "Remotion root not found" });
    }

    // Get video duration in frames
    const durCmd = [
      "ffprobe",
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      inputPath,
    ];
    const durResult = await this.runCommand(durCmd);
    const durOut = String(durResult.stdout);
    const durationS = parseFloat(durOut.trim().split("\n")[0] ?? "");
    const totalFrames = Math.ceil(durationS * 30);

    // Detect video dimensions
    const dimCmd = [
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "csv=p=0:s=x",
      inputPath,
    ];
    const dimResult = await this.runCommand(dimCmd);
    const dimParts = String(dimResult.stdout).trim().split("x");
    const width = parseInt(dimParts[0]!, 10);
    const height = parseInt(dimParts[1]!, 10);

    // Copy video to Remotion public folder
    const pubDir = path.join(root, "public", "talking-head");
    fs.mkdirSync(pubDir, { recursive: true });
    const videoFilename = path.basename(inputPath);
    const destVideo = path.join(pubDir, videoFilename);
    fs.copyFileSync(inputPath, destVideo);

    // Build props JSON
    const props = {
      videoSrc: `public/talking-head/${videoFilename}`,
      captions,
      overlays: overlays ?? [],
      wordsPerPage,
      fontSize,
      highlightColor,
    };
    const propsDir = path.join(root, "public", "demo-props");
    fs.mkdirSync(propsDir, { recursive: true });
    const stem = path.basename(inputPath, path.extname(inputPath));
    const propsFile = path.join(propsDir, `caption-burn-${stem}.json`);
    fs.writeFileSync(propsFile, JSON.stringify(props, null, 2), {
      encoding: "utf-8",
    });

    // Render. execa resolves npx (and npx.cmd on Windows) natively.
    const propsRel = path.relative(root, propsFile);
    const renderCmd = [
      "npx",
      "remotion",
      "render",
      "TalkingHead",
      `--props=${propsRel}`,
      `--width=${width}`,
      `--height=${height}`,
      "--fps=30",
      `--frames=0-${totalFrames - 1}`,
      "--codec=h264",
      "--crf=18",
      `--output=${path.resolve(outputPath)}`,
    ];
    await this.runCommand(renderCmd, { cwd: root });

    if (!fs.existsSync(outputPath)) {
      return toolResult({
        success: false,
        error: "Remotion render produced no output",
      });
    }

    return toolResult({
      success: true,
      data: {
        method: "remotion",
        output: outputPath,
        duration_seconds: Math.round(durationS * 100) / 100,
        total_frames: totalFrames,
        caption_count: captions.length,
        overlay_count: (overlays ?? []).length,
        words_per_page: wordsPerPage,
      },
      artifacts: [outputPath],
    });
  }

  // ------------------------------------------------------------------ //
  //  FFmpeg fallback
  // ------------------------------------------------------------------ //

  /** Fall back to FFmpeg subtitle burning at bottom of frame. */
  private async _renderFfmpeg(
    inputPath: string,
    outputPath: string,
    captions: WordCaption[]
  ): Promise<ToolResult> {
    // Generate temporary SRT from word captions
    const tmpSrt = path.join(
      path.dirname(outputPath),
      `_tmp_captions_${Math.trunc(Date.now() / 1000)}.srt`
    );
    fs.mkdirSync(path.dirname(tmpSrt), { recursive: true });

    const srtLines: string[] = [];
    let idx = 1;
    // Group into pages of ~4 words
    const pageSize = 4;
    for (let i = 0; i < captions.length; i += pageSize) {
      const page = captions.slice(i, i + pageSize);
      const text = page.map((c) => c.word).join(" ");
      const start = page[0]!.startMs;
      const end = page[page.length - 1]!.endMs;
      srtLines.push(String(idx));
      srtLines.push(
        `${RemotionCaptionBurn._msToSrt(start)} --> ${RemotionCaptionBurn._msToSrt(end)}`
      );
      srtLines.push(text);
      srtLines.push("");
      idx += 1;
    }

    fs.writeFileSync(tmpSrt, srtLines.join("\n"), { encoding: "utf-8" });

    // Escape path for FFmpeg subtitles filter (Windows colon issue)
    const srtEscaped = tmpSrt.replace(/\\/g, "/").replace(/:/g, "\\:");

    const cmd = [
      "ffmpeg",
      "-y",
      "-i",
      inputPath,
      "-vf",
      `subtitles='${srtEscaped}'` +
        ":force_style='FontName=Segoe UI,FontSize=24,Bold=1," +
        "PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000," +
        "Outline=3,Shadow=2,Alignment=2,MarginV=100'",
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "copy",
      outputPath,
    ];
    await this.runCommand(cmd);

    // Clean up temp SRT
    try {
      fs.unlinkSync(tmpSrt);
    } catch {
      /* ignore */
    }

    if (!fs.existsSync(outputPath)) {
      return toolResult({
        success: false,
        error: "FFmpeg subtitle burn produced no output",
      });
    }

    return toolResult({
      success: true,
      data: {
        method: "ffmpeg_fallback",
        output: outputPath,
        caption_count: captions.length,
        note: "Used FFmpeg fallback. Install Remotion for animated captions.",
      },
      artifacts: [outputPath],
    });
  }

  private static _msToSrt(ms: number): string {
    const h = Math.trunc(ms / 3600000);
    const m = Math.trunc((ms % 3600000) / 60000);
    const s = Math.trunc((ms % 60000) / 1000);
    const rem = ms % 1000;
    return `${pad2(h)}:${pad2(m)}:${pad2(s)},${pad3(rem)}`;
  }

  // ------------------------------------------------------------------ //
  //  Main execute
  // ------------------------------------------------------------------ //

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const inputPath = inputs.input_path as string;
    const outputPath = inputs.output_path as string;
    const corrections = inputs.corrections as Record<string, string> | undefined;
    const forceFfmpeg = (inputs.force_ffmpeg as boolean) ?? false;
    const wordsPerPage = (inputs.words_per_page as number) ?? 4;
    const fontSize = (inputs.font_size as number) ?? 52;
    const highlightColor = (inputs.highlight_color as string) ?? "#22D3EE";

    if (!fs.existsSync(inputPath)) {
      return toolResult({
        success: false,
        error: `Input video not found: ${inputPath}`,
      });
    }

    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    const start = Date.now();

    // Build word captions from segments or SRT
    const segments = inputs.segments as Segment[] | undefined;
    const srtPath = inputs.srt_path as string | undefined;

    let captions: WordCaption[];
    if (segments) {
      captions = this._segmentsToWordCaptions(segments, corrections);
    } else if (srtPath) {
      captions = this._srtToWordCaptions(srtPath, corrections);
    } else {
      return toolResult({
        success: false,
        error: "Provide either 'segments' (from transcriber) or 'srt_path'.",
      });
    }

    if (!captions.length) {
      return toolResult({ success: false, error: "No caption words extracted." });
    }

    const overlays = inputs.overlays as Record<string, unknown>[] | undefined;

    // Choose render method
    let result: ToolResult;
    if (!forceFfmpeg && this._remotionAvailable()) {
      result = await this._renderRemotion(
        inputPath,
        outputPath,
        captions,
        wordsPerPage,
        fontSize,
        highlightColor,
        overlays
      );
    } else {
      result = await this._renderFfmpeg(inputPath, outputPath, captions);
    }

    result.duration_seconds = Math.round(((Date.now() - start) / 1000) * 100) / 100;
    return result;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

/** Mirror Python str.strip(chars): strip any leading/trailing chars in `chars`. */
function strip(s: string, chars: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && chars.includes(s[start]!)) {
    start += 1;
  }
  while (end > start && chars.includes(s[end - 1]!)) {
    end -= 1;
  }
  return s.slice(start, end);
}
