/**
 * Showcase card tool wrapping FFmpeg.
 *
 * TypeScript port of tools/video/showcase_card.py. Creates a presentation-ready
 * 9:16 card from a source video: letterboxes the content, adds a bold title at
 * the top, a subtitle description at the bottom, and a dark background. Designed
 * for Instagram Reels / TikTok showcase segments.
 *
 * Parity notes vs. Python:
 *  - The ffprobe csv=p=0 invocation, the scale/pad/drawtext filter strings, the
 *    drawtext escaping (`'` -> `\'`, `:` -> `\:`), and the encode argument array
 *    are copied verbatim.
 *  - subprocess.run -> this.runCommand (execa). The probe parse mirrors
 *    `[int(x.strip()) for x in out.split(",")[:2]]`.
 */
import fs from "node:fs";
import path from "node:path";
import {
  BaseTool,
  Determinism,
  ExecutionMode,
  ResourceProfile,
  ToolResult,
  ToolStability,
  ToolTier,
  toolResult,
} from "../base_tool.js";

export class ShowcaseCard extends BaseTool {
  override name = "showcase_card";
  override version = "0.1.0";
  override tier = ToolTier.CORE;
  override capability = "video_post";
  override provider = "ffmpeg";
  override stability = ToolStability.EXPERIMENTAL;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;

  override dependencies = ["cmd:ffmpeg", "cmd:ffprobe"];
  override install_instructions = "Install FFmpeg: https://ffmpeg.org/download.html";
  override agent_skills = ["ffmpeg", "video_toolkit"];

  override capabilities = ["create_showcase_card"];

  override input_schema = {
    type: "object",
    required: ["input_path", "output_path", "title"],
    properties: {
      input_path: {
        type: "string",
        description: "Path to the source video.",
      },
      output_path: {
        type: "string",
        description: "Path for the output showcase card video.",
      },
      title: {
        type: "string",
        description: "Bold title text displayed at the top of the card.",
      },
      subtitle: {
        type: "string",
        default: "",
        description: "Subtitle text displayed at the bottom of the card.",
      },
      output_width: {
        type: "integer",
        default: 1080,
        description: "Output width in pixels.",
      },
      output_height: {
        type: "integer",
        default: 1920,
        description: "Output height in pixels.",
      },
      background_color: {
        type: "string",
        default: "0x0A0F1A",
        description: "Background color in hex (FFmpeg format, e.g. 0x0A0F1A).",
      },
      title_font: {
        type: "string",
        default: "segoeuib.ttf",
        description: "Font file for the title. Uses system font lookup.",
      },
      title_font_size: {
        type: "integer",
        default: 52,
        description: "Font size for the title.",
      },
      subtitle_font_size: {
        type: "integer",
        default: 28,
        description: "Font size for the subtitle.",
      },
      title_color: {
        type: "string",
        default: "white",
        description: "Title text color.",
      },
      watermark: {
        type: "string",
        default: "",
        description: "Optional watermark text overlaid on the video (e.g. brand name).",
      },
    },
  };

  override resource_profile: ResourceProfile = {
    cpu_cores: 2,
    ram_mb: 1024,
    vram_mb: 0,
    disk_mb: 500,
    network_required: false,
  };
  override idempotency_key_fields = ["input_path", "title", "subtitle"];
  override side_effects = ["writes showcase card video to output_path"];
  override user_visible_verification = [
    "Play output and verify title, subtitle, and video are positioned correctly",
    "Verify the video content is fully visible (not cropped)",
  ];

  override async execute(inputs: Record<string, any>): Promise<ToolResult> {
    const inputPath = inputs.input_path as string;
    const outputPath = inputs.output_path as string;
    const title = inputs.title as string;
    const subtitle = (inputs.subtitle as string) ?? "";
    const outW = inputs.output_width ?? 1080;
    const outH = inputs.output_height ?? 1920;
    const bgColor = (inputs.background_color as string) ?? "0x0A0F1A";
    const titleFont = (inputs.title_font as string) ?? "segoeuib.ttf";
    const titleFontSize = inputs.title_font_size ?? 52;
    const subtitleFontSize = inputs.subtitle_font_size ?? 28;
    const titleColor = (inputs.title_color as string) ?? "white";
    const watermark = (inputs.watermark as string) ?? "";

    if (!fs.existsSync(inputPath)) {
      return toolResult({ success: false, error: `Input not found: ${inputPath}` });
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const start = Date.now();

    // Get source dimensions
    const probeCmd = [
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "csv=p=0",
      inputPath,
    ];
    const probeOut = String((await this.runCommand(probeCmd)).stdout).trim();
    const [srcW, srcH] = probeOut
      .split(",")
      .slice(0, 2)
      .map((x: string) => parseInt(x.trim(), 10));

    // Calculate letterbox dimensions — fit source into output width,
    // center vertically in the frame.
    const scaleFactor = outW / srcW!;
    let scaledH = Math.trunc(srcH! * scaleFactor);
    // Ensure even dimensions
    scaledH = scaledH % 2 === 0 ? scaledH : scaledH + 1;
    const padY = Math.trunc((outH - scaledH) / 2);

    // Build filter chain
    const filters: string[] = [
      `scale=${outW}:${scaledH}`,
      `pad=${outW}:${outH}:0:${padY}:color=${bgColor}`,
    ];

    // Title text at top
    const titleEscaped = title.replace(/'/g, "\\'").replace(/:/g, "\\:");
    filters.push(
      `drawtext=text='${titleEscaped}'` +
        `:fontfile='${titleFont}'` +
        `:fontsize=${titleFontSize}` +
        `:fontcolor=${titleColor}` +
        `:borderw=3:bordercolor=black` +
        `:x=(w-text_w)/2:y=60`
    );

    // Subtitle text at bottom
    if (subtitle) {
      const subEscaped = subtitle.replace(/'/g, "\\'").replace(/:/g, "\\:");
      filters.push(
        `drawtext=text='${subEscaped}'` +
          `:fontfile='segoeui.ttf'` +
          `:fontsize=${subtitleFontSize}` +
          `:fontcolor=white@0.85` +
          `:x=(w-text_w)/2:y=h-100`
      );
    }

    // Watermark centered on video
    if (watermark) {
      const wmEscaped = watermark.replace(/'/g, "\\'").replace(/:/g, "\\:");
      filters.push(
        `drawtext=text='${wmEscaped}'` +
          `:fontfile='segoeui.ttf'` +
          `:fontsize=36` +
          `:fontcolor=white@0.3` +
          `:x=(w-text_w)/2:y=(h-text_h)/2`
      );
    }

    const vf = filters.join(",");

    const cmd = [
      "ffmpeg",
      "-y",
      "-i",
      inputPath,
      "-vf",
      vf,
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      outputPath,
    ];

    try {
      await this.runCommand(cmd);
    } catch (e) {
      return toolResult({ success: false, error: `FFmpeg failed: ${(e as Error).message ?? e}` });
    }

    if (!fs.existsSync(outputPath)) {
      return toolResult({ success: false, error: "No output produced" });
    }

    const elapsed = Math.round((Date.now() - start) / 10) / 100;

    return toolResult({
      success: true,
      data: {
        output: outputPath,
        source_resolution: `${srcW}x${srcH}`,
        output_resolution: `${outW}x${outH}`,
        title,
        subtitle,
        letterbox_y_offset: padY,
      },
      artifacts: [outputPath],
      duration_seconds: elapsed,
    });
  }
}
