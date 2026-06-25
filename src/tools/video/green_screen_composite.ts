/**
 * Green screen composite tool for talking-head pipeline.
 *
 * TypeScript port of tools/video/green_screen_composite.py. Composites a keyed
 * speaker (dark/solid background) over a Remotion background video with layout
 * presets. Supports news anchor, full behind, picture-in-picture, and split
 * layouts.
 *
 * Uses @napi-rs/canvas for frame-level alpha compositing (the PIL/numpy work in
 * the original) and FFmpeg for frame extraction, encoding, and audio muxing.
 *
 * Parity notes vs. Python:
 *  - All ffprobe/ffmpeg argument arrays (frame extraction `fps=`, the libx264
 *    encode with scale, and the audio-mux map/-shortest invocation) are copied
 *    verbatim.
 *  - The alpha-key math is reproduced exactly: per-pixel Euclidean distance to
 *    the keyed background colour, alpha = clip((dist - 35) * 8, 0, 255). The
 *    layout geometry (scale factors, paste offsets, PiP 0.30 / margin 20, split
 *    half-width) matches the Python verbatim.
 *  - DEVIATION: PIL's Image.LANCZOS resize is replaced with the canvas 2D
 *    high-quality resampler (imageSmoothingQuality="high"). Pixel values around
 *    edges differ slightly from PIL LANCZOS, but the composite is visually
 *    equivalent — the resampling kernel is not behaviorally load-bearing.
 *  - numpy/PIL python: dependencies are dropped (the TS port has no python:
 *    dependency prefix). dependencies stays ["cmd:ffmpeg"] so getStatus()
 *    reports availability from FFmpeg alone, matching how the registry treats
 *    this provider in the TS port.
 */
import fs from "node:fs";
import path from "node:path";
import {
  createCanvas,
  loadImage,
  type SKRSContext2D,
  type Image as CanvasImage,
} from "@napi-rs/canvas";
import {
  BaseTool,
  Determinism,
  ExecutionMode,
  ResourceProfile,
  ResumeSupport,
  RetryPolicy,
  ToolResult,
  ToolStability,
  ToolTier,
  toolResult,
} from "../base_tool.js";

interface VideoInfo {
  fps: number;
  duration: number;
  width: number;
  height: number;
}

export class GreenScreenComposite extends BaseTool {
  override name = "green_screen_composite";
  override version = "0.1.0";
  override tier = ToolTier.CORE;
  override capability = "video_post";
  override provider = "ffmpeg";
  override stability = ToolStability.EXPERIMENTAL;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;

  // python:numpy and python:PIL dropped (no python: prefix in the TS port);
  // canvas compositing is bundled. FFmpeg remains the only external command.
  override dependencies = ["cmd:ffmpeg"];
  override install_instructions =
    "Install FFmpeg: https://ffmpeg.org/download.html — pip install numpy Pillow";
  override agent_skills = ["ffmpeg"];

  override capabilities = [
    "green_screen_composite",
    "speaker_overlay",
    "layout_preset",
    "alpha_composite",
  ];

  override input_schema = {
    type: "object",
    required: ["speaker_path", "background_path", "output_path"],
    properties: {
      speaker_path: {
        type: "string",
        description: "Path to keyed speaker video (dark bg, from green_screen_processor)",
      },
      background_path: {
        type: "string",
        description: "Path to Remotion background video",
      },
      output_path: {
        type: "string",
        description: "Output composite video path",
      },
      original_audio_path: {
        type: "string",
        description: "Path to original footage to extract audio from",
      },
      layout: {
        type: "string",
        enum: ["news_anchor", "full_behind", "pip", "split"],
        default: "news_anchor",
        description:
          "news_anchor=speaker bottom-center over shifted bg, " +
          "full_behind=speaker full-frame on bg, " +
          "pip=speaker 30% bottom-right, " +
          "split=speaker left 50% bg right 50%",
      },
      speaker_scale: {
        type: "number",
        default: 0.65,
        description: "Scale factor for speaker layer",
      },
      bg_shift_up: {
        type: "integer",
        default: 300,
        description: "Pixels to shift background content upward",
      },
      bg_color_hex: {
        type: "string",
        default: "#0E172A",
        description: "The keyed speaker's background color for alpha creation",
      },
    },
  };

  override resource_profile: ResourceProfile = {
    cpu_cores: 4,
    ram_mb: 4096,
    vram_mb: 0,
    disk_mb: 8000,
    network_required: false,
  };
  override retry_policy: RetryPolicy = {
    max_retries: 1,
    backoff_seconds: 1.0,
    retryable_errors: ["FFmpeg error"],
  };
  override resume_support = ResumeSupport.FROM_START;
  override idempotency_key_fields = [
    "speaker_path",
    "background_path",
    "layout",
    "speaker_scale",
    "bg_shift_up",
    "bg_color_hex",
  ];
  override side_effects = ["writes composite video to output_path"];
  override user_visible_verification = [
    "Watch output — speaker should be cleanly composited without color fringing",
    "Check layout positioning matches the chosen preset",
    "Verify audio is synced if original_audio_path was provided",
  ];

  override async execute(inputs: Record<string, any>): Promise<ToolResult> {
    const speakerPath = inputs.speaker_path as string;
    const backgroundPath = inputs.background_path as string;
    const outputPath = inputs.output_path as string;
    const originalAudioPath = inputs.original_audio_path as string | undefined;
    const layout = (inputs.layout as string) ?? "news_anchor";
    const speakerScale = (inputs.speaker_scale as number) ?? 0.65;
    const bgShiftUp = inputs.bg_shift_up ?? 300;
    const bgColorHex = (inputs.bg_color_hex as string) ?? "#0E172A";

    if (!fs.existsSync(speakerPath)) {
      return toolResult({ success: false, error: `Speaker video not found: ${speakerPath}` });
    }
    if (!fs.existsSync(backgroundPath)) {
      return toolResult({ success: false, error: `Background video not found: ${backgroundPath}` });
    }
    if (originalAudioPath && !fs.existsSync(originalAudioPath)) {
      return toolResult({ success: false, error: `Audio source not found: ${originalAudioPath}` });
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const start = Date.now();

    // Parse bg color
    const bgColor = this._parseHexColor(bgColorHex);

    // Step 1: Probe both videos
    const speakerInfo = await this._probeVideo(speakerPath);
    const bgInfo = await this._probeVideo(backgroundPath);

    if (!speakerInfo || !bgInfo) {
      return toolResult({ success: false, error: "Failed to probe one or both input videos" });
    }

    // Step 2: Use the LOWER fps (typically 15fps from speaker)
    let targetFps = Math.min(speakerInfo.fps, bgInfo.fps);
    if (targetFps <= 0) {
      targetFps = 15.0;
    }

    // Determine output dimensions from background
    const outW = bgInfo.width;
    const outH = bgInfo.height;

    // Use shorter duration
    const duration = Math.min(speakerInfo.duration, bgInfo.duration);

    // Step 3: Extract frames from both videos
    const tempDir = path.join(path.dirname(outputPath), ".greenscreen_composite_tmp");
    const speakerFramesDir = path.join(tempDir, "speaker");
    const bgFramesDir = path.join(tempDir, "bg");
    const compFramesDir = path.join(tempDir, "composite");

    for (const d of [speakerFramesDir, bgFramesDir, compFramesDir]) {
      fs.mkdirSync(d, { recursive: true });
    }

    try {
      await this._extractFrames(speakerPath, speakerFramesDir, targetFps);
      await this._extractFrames(backgroundPath, bgFramesDir, targetFps);

      // Get sorted frame lists
      const speakerFrames = GreenScreenComposite._globPng(speakerFramesDir);
      const bgFrames = GreenScreenComposite._globPng(bgFramesDir);

      if (speakerFrames.length === 0 || bgFrames.length === 0) {
        return toolResult({ success: false, error: "Frame extraction produced no frames" });
      }

      const frameCount = Math.min(speakerFrames.length, bgFrames.length);
      const logInterval = Math.max(1, Math.trunc(frameCount / 10));

      // Step 4: Composite each frame pair
      for (let i = 0; i < frameCount; i++) {
        if (i % logInterval === 0) {
          console.log(`[green_screen_composite] Compositing frame ${i + 1}/${frameCount}`);
        }

        const speakerImg = await loadImage(speakerFrames[i]!);
        const bgImg = await loadImage(bgFrames[i]!);

        const comp = this._compositeFrame(speakerImg, bgImg, bgColor, {
          layout,
          speakerScale,
          bgShiftUp,
          outW,
          outH,
        });
        fs.writeFileSync(
          path.join(compFramesDir, `frame_${String(i).padStart(6, "0")}.png`),
          comp
        );
      }

      console.log(`[green_screen_composite] All ${frameCount} frames composited`);

      // Step 5: Encode composite frames to video
      const noAudioPath = !originalAudioPath ? outputPath : path.join(tempDir, "no_audio.mp4");
      await this._encodeFrames(compFramesDir, noAudioPath, targetFps, outW, outH);

      // Step 6: Mux audio if provided
      if (originalAudioPath) {
        await this._muxAudio(noAudioPath, originalAudioPath, outputPath, duration);
      }

      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
        return toolResult({ success: false, error: "Output video was not created" });
      }

      const elapsed = (Date.now() - start) / 1000;

      return toolResult({
        success: true,
        data: {
          output: outputPath,
          layout,
          fps: targetFps,
          frame_count: frameCount,
          duration: Math.round(duration * 100) / 100,
          dimensions: `${outW}x${outH}`,
          speaker_scale: speakerScale,
          has_audio: Boolean(originalAudioPath),
        },
        artifacts: [outputPath],
        duration_seconds: Math.round(elapsed * 100) / 100,
      });
    } catch (e) {
      return toolResult({ success: false, error: `Composite failed: ${(e as Error).message ?? e}` });
    } finally {
      // Step 7: Clean up temp directories
      this._cleanupTemp(tempDir);
    }
  }

  private _parseHexColor(hexStr: string): [number, number, number] {
    // Parse a hex color string like '#0E172A' to an RGB tuple.
    const h = hexStr.replace(/^#/, "");
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return [r, g, b];
  }

  private async _probeVideo(p: string): Promise<VideoInfo | null> {
    // Probe a video for fps, duration, and dimensions.
    const cmd = [
      "ffprobe",
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      p,
    ];
    let data: { streams?: Array<Record<string, any>>; format?: Record<string, any> };
    try {
      const result = await this.runCommand(cmd, { timeout: 30000 });
      data = JSON.parse(String(result.stdout));
    } catch {
      return null;
    }

    // Find video stream
    let videoStream: Record<string, any> | null = null;
    for (const stream of data.streams ?? []) {
      if (stream.codec_type === "video") {
        videoStream = stream;
        break;
      }
    }

    if (!videoStream) {
      return null;
    }

    // Parse fps from r_frame_rate (e.g., "30/1" or "15000/1001")
    const fpsStr = (videoStream.r_frame_rate as string) ?? "30/1";
    let fps: number;
    try {
      const [num, den] = fpsStr.split("/");
      const denN = parseFloat(den!);
      if (denN === 0) throw new Error("ZeroDivisionError");
      fps = parseFloat(num!) / denN;
      if (!Number.isFinite(fps)) throw new Error("ValueError");
    } catch {
      fps = 30.0;
    }

    const duration = parseFloat(data.format?.duration ?? "0") || 0;

    return {
      fps,
      duration,
      width: parseInt(String(videoStream.width ?? 1920), 10),
      height: parseInt(String(videoStream.height ?? 1080), 10),
    };
  }

  private async _extractFrames(
    videoPath: string,
    outputDir: string,
    fps: number
  ): Promise<void> {
    // Extract frames from a video at the given fps.
    const cmd = [
      "ffmpeg",
      "-y",
      "-i",
      videoPath,
      "-vf",
      `fps=${fps}`,
      path.join(outputDir, "frame_%06d.png"),
    ];
    await this.runCommand(cmd, { timeout: 600000 });
  }

  /**
   * Composite a single speaker frame over a background frame using the layout.
   * Returns the encoded PNG buffer (RGB output, matching PIL .convert("RGB")).
   */
  private _compositeFrame(
    speakerImg: CanvasImage,
    bgImg: CanvasImage,
    bgColor: [number, number, number],
    opts: {
      layout: string;
      speakerScale: number;
      bgShiftUp: number;
      outW: number;
      outH: number;
    }
  ): Buffer {
    const { layout, speakerScale, bgShiftUp, outW, outH } = opts;

    // Create alpha mask from speaker frame:
    //   dist = sqrt(sum((arr - bg_color)^2)); alpha = clip((dist-35)*8, 0, 255)
    const spW = speakerImg.width;
    const spH = speakerImg.height;
    const speakerRgba = createCanvas(spW, spH);
    const sCtx = speakerRgba.getContext("2d");
    sCtx.drawImage(speakerImg, 0, 0);
    const sData = sCtx.getImageData(0, 0, spW, spH);
    const pix = sData.data;
    const [br, bg, bb] = bgColor;
    const threshold = 35;
    for (let p = 0; p < pix.length; p += 4) {
      const dr = pix[p]! - br;
      const dg = pix[p + 1]! - bg;
      const db = pix[p + 2]! - bb;
      const dist = Math.sqrt(dr * dr + dg * dg + db * db);
      // clip((dist - threshold) * 8, 0, 255) -> uint8
      let a = (dist - threshold) * 8;
      if (a < 0) a = 0;
      else if (a > 255) a = 255;
      pix[p + 3] = a & 0xff; // astype(uint8)
    }
    sCtx.putImageData(sData, 0, 0);

    // Prepare background canvas at output size (filled opaque black like PIL).
    const canvas = createCanvas(outW, outH);
    const ctx = canvas.getContext("2d");
    GreenScreenComposite._enableHQ(ctx);
    ctx.fillStyle = "rgba(0,0,0,1)";
    ctx.fillRect(0, 0, outW, outH);

    if (layout === "news_anchor") {
      // Background shifted up so graphics appear above speaker's head
      // shifted_bg: opaque black, with bg resized to out size pasted at (0, -shift)
      ctx.drawImage(bgImg, 0, -bgShiftUp, outW, outH);

      // Scale speaker and place at bottom center
      const spwScaled = Math.trunc(spW * speakerScale);
      const sphScaled = Math.trunc(spH * speakerScale);
      const x = Math.trunc((outW - spwScaled) / 2);
      const y = outH - sphScaled;
      ctx.drawImage(speakerRgba, x, y, spwScaled, sphScaled);
    } else if (layout === "full_behind") {
      // Speaker full-frame on background, no scaling, no shifting
      ctx.drawImage(bgImg, 0, 0, outW, outH);
      // Resize speaker to match output
      ctx.drawImage(speakerRgba, 0, 0, outW, outH);
    } else if (layout === "pip") {
      // Background full-frame, speaker 30% in bottom-right
      ctx.drawImage(bgImg, 0, 0, outW, outH);

      const pipScale = 0.3;
      const spwScaled = Math.trunc(outW * pipScale);
      const sphScaled = Math.trunc(outH * pipScale);
      const margin = 20;
      const x = outW - spwScaled - margin;
      const y = outH - sphScaled - margin;
      ctx.drawImage(speakerRgba, x, y, spwScaled, sphScaled);
    } else if (layout === "split") {
      // Speaker on left 50%, background on right 50%
      const halfW = Math.trunc(outW / 2);
      // Left side: speaker resized to fill left half
      ctx.drawImage(speakerRgba, 0, 0, halfW, outH);
      // Right side: background cropped/resized to fill right half
      ctx.drawImage(bgImg, halfW, 0, halfW, outH);
    }

    // Convert to RGB for output: flatten onto an opaque canvas, encode PNG.
    // (PIL .convert("RGB") drops alpha; our canvas background is already opaque
    // black, so flattening is implicit. Encode straight to PNG.)
    return canvas.toBuffer("image/png");
  }

  private async _encodeFrames(
    framesDir: string,
    outputPath: string,
    fps: number,
    width: number,
    height: number
  ): Promise<void> {
    // Encode PNG frames to an MP4 video.
    const cmd = [
      "ffmpeg",
      "-y",
      "-framerate",
      String(fps),
      "-i",
      path.join(framesDir, "frame_%06d.png"),
      "-c:v",
      "libx264",
      "-crf",
      "18",
      "-preset",
      "fast",
      "-pix_fmt",
      "yuv420p",
      "-vf",
      `scale=${width}:${height}`,
      outputPath,
    ];
    await this.runCommand(cmd, { timeout: 600000 });
  }

  private async _muxAudio(
    videoPath: string,
    audioSource: string,
    outputPath: string,
    duration: number
  ): Promise<void> {
    // Mux audio from the original source into the composite video.
    const cmd = [
      "ffmpeg",
      "-y",
      "-i",
      videoPath,
      "-i",
      audioSource,
      "-t",
      duration.toFixed(3),
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-shortest",
      outputPath,
    ];
    await this.runCommand(cmd, { timeout: 300000 });
  }

  private _cleanupTemp(tempDir: string): void {
    // Remove temporary frame directories.
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; log but don't fail
        console.log(`[green_screen_composite] Warning: could not fully clean ${tempDir}`);
      }
    }
  }

  /** Sorted list of *.png files in a dir (mirrors Path.glob("*.png") + sorted). */
  private static _globPng(dir: string): string[] {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return [];
    }
    return entries
      .filter((f) => f.toLowerCase().endsWith(".png"))
      .sort()
      .map((f) => path.join(dir, f));
  }

  /** Enable high-quality (LANCZOS-equivalent) resampling for drawImage scaling. */
  private static _enableHQ(ctx: SKRSContext2D): void {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
  }

  override estimateRuntime(_inputs: Record<string, unknown>): number {
    return 120.0;
  }
}
