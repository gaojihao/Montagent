/**
 * Green screen keying processor.
 *
 * TypeScript port of tools/video/green_screen_processor.py. Removes green/blue
 * screen backgrounds from footage using FFmpeg chromakey filtering, with
 * automatic method detection by analyzing frame color histograms.
 *
 * Methods:
 *   - auto: Analyze frames to pick the best method (chromakey vs rembg)
 *   - chromakey: FFmpeg chromakey filter (fast, works well on clean screens)
 *   - rembg: AI background removal via rembg/u2net (slower, handles any bg)
 *
 * Parity notes vs. Python:
 *  - All ffprobe/ffmpeg argument arrays, the chromakey/colorkey/alphaextract/
 *    blackframe/signalstats filter strings, the pblack regex parse, the
 *    color=c=<hex> background source, and the reconstruct argument array are
 *    copied verbatim.
 *  - The "rembg" branch is AI/ML segmentation (PyTorch/onnxruntime + the rembg
 *    package), which is excluded from this FFmpeg port. _processRembg therefore
 *    returns false — identical to the Python `except ImportError: return False`
 *    path on a host without rembg installed. "auto" detection and "chromakey"
 *    are fully ported and exercise FFmpeg verbatim. When auto picks rembg (no
 *    clean green screen), execute() returns the same "Frame processing failed
 *    with method=rembg" error Python returns without rembg.
 *  - Python read ffmpeg's filter/blackframe output from result.stderr (the
 *    `-f null` runs exit 0); execa surfaces that on the resolved result.stderr.
 */
import fs from "node:fs";
import path from "node:path";
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

interface ProbeResult {
  duration: number;
  width: number;
  height: number;
  fps: number;
}

export class GreenScreenProcessor extends BaseTool {
  override name = "green_screen_processor";
  override version = "0.1.0";
  override tier = ToolTier.CORE;
  override capability = "video_post";
  override provider = "ffmpeg";
  override stability = ToolStability.EXPERIMENTAL;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;

  override dependencies = ["cmd:ffmpeg"];
  override install_instructions =
    "Install FFmpeg: https://ffmpeg.org/download.html  " +
    "For rembg method: pip install rembg[gpu] onnxruntime";
  override agent_skills = ["ffmpeg"];

  override capabilities = [
    "green_screen_keying",
    "chromakey",
    "background_removal",
    "rembg_segmentation",
  ];

  override input_schema = {
    type: "object",
    required: ["input_path", "output_path"],
    properties: {
      input_path: {
        type: "string",
        description: "Path to raw green screen footage",
      },
      output_path: {
        type: "string",
        description: "Path for keyed output video",
      },
      method: {
        type: "string",
        enum: ["auto", "chromakey", "rembg"],
        default: "auto",
        description:
          "Keying method: auto detects best approach, chromakey uses FFmpeg, rembg uses AI segmentation",
      },
      fps: {
        type: "integer",
        default: 15,
        description: "Output frames per second",
      },
      bg_color: {
        type: "string",
        default: "#0E172A",
        description: "Hex color for output background",
      },
      max_frames: {
        type: "integer",
        default: 0,
        description: "Limit frames to process (0 = all)",
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
  override idempotency_key_fields = ["input_path", "method", "fps", "bg_color", "max_frames"];
  override side_effects = ["writes keyed video to output_path"];
  override user_visible_verification = [
    "Check output for green fringing around subject edges",
    "Verify background is cleanly replaced with target color",
    "Look for flickering or inconsistent keying between frames",
  ];

  // Platform-specific null device
  private static readonly _nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";

  override async execute(inputs: Record<string, any>): Promise<ToolResult> {
    const inputPath = inputs.input_path as string;
    if (!fs.existsSync(inputPath)) {
      return toolResult({ success: false, error: `Input not found: ${inputPath}` });
    }

    const outputPath = inputs.output_path as string;
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    let method = (inputs.method as string) ?? "auto";
    const fps = inputs.fps ?? 15;
    const bgColor = (inputs.bg_color as string) ?? "#0E172A";
    const maxFrames = inputs.max_frames ?? 0;
    const start = Date.now();

    // Step 1: Probe input video
    const probe = await this._probeVideo(inputPath);
    if (!probe) {
      return toolResult({ success: false, error: "Failed to probe input video" });
    }

    const duration = probe.duration;
    const width = probe.width;
    const height = probe.height;

    // Step 2: Determine method
    if (method === "auto") {
      method = await this._autoDetectMethod(inputPath, duration, width, height);
    }

    // Step 3: Set up temp directory for frame processing
    const tempDir = path.join(
      path.dirname(outputPath),
      `.gs_tmp_${Math.floor(Date.now() / 1000)}`
    );
    fs.mkdirSync(tempDir, { recursive: true });

    try {
      // Step 4: Extract frames at target fps
      const framesDir = path.join(tempDir, "frames");
      fs.mkdirSync(framesDir, { recursive: true });
      const frameCount = await this._extractFrames(inputPath, framesDir, fps, maxFrames);
      if (frameCount === 0) {
        return toolResult({ success: false, error: "No frames extracted from input" });
      }

      // Step 5: Process frames
      const processedDir = path.join(tempDir, "processed");
      fs.mkdirSync(processedDir, { recursive: true });

      let ok: boolean;
      if (method === "chromakey") {
        ok = await this._processChromakey(framesDir, processedDir, bgColor, frameCount);
      } else {
        ok = await this._processRembg(framesDir, processedDir, bgColor, frameCount);
      }

      if (!ok) {
        return toolResult({
          success: false,
          error: `Frame processing failed with method=${method}`,
        });
      }

      // Step 6: Reconstruct video from processed frames
      await this._reconstructVideo(processedDir, outputPath, fps, width, height);

      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
        return toolResult({ success: false, error: "Output video was not created" });
      }

      const elapsed = (Date.now() - start) / 1000;

      return toolResult({
        success: true,
        data: {
          method_used: method,
          frame_count: frameCount,
          duration: Math.round(duration * 100) / 100,
          output_path: outputPath,
          resolution: `${width}x${height}`,
          fps,
          bg_color: bgColor,
        },
        artifacts: [outputPath],
        duration_seconds: Math.round(elapsed * 100) / 100,
      });
    } catch (e) {
      return toolResult({
        success: false,
        error: `Green screen processing failed: ${(e as Error).message ?? e}`,
      });
    } finally {
      // Clean up temp directory
      GreenScreenProcessor._cleanupDir(tempDir);
    }
  }

  private async _probeVideo(inputPath: string): Promise<ProbeResult | null> {
    // Probe video for duration, dimensions, and fps.
    const cmd = [
      "ffprobe",
      "-v",
      "quiet",
      "-show_entries",
      "format=duration:stream=width,height,r_frame_rate",
      "-select_streams",
      "v:0",
      "-of",
      "json",
      inputPath,
    ];
    try {
      const result = await this.runCommand(cmd, { timeout: 30000 });
      const data = JSON.parse(String(result.stdout)) as {
        format?: { duration?: string };
        streams?: Array<Record<string, any>>;
      };

      const duration = parseFloat(data.format?.duration ?? "0") || 0;

      const stream = (data.streams ?? [{}])[0] ?? {};
      const width = parseInt(String(stream.width ?? 0), 10) || 0;
      const height = parseInt(String(stream.height ?? 0), 10) || 0;

      // Parse r_frame_rate like "30/1" or "30000/1001"
      const fpsStr = (stream.r_frame_rate as string) ?? "30/1";
      let fpsVal: number;
      if (fpsStr.includes("/")) {
        const [num, den] = fpsStr.split("/");
        fpsVal = parseFloat(den!) !== 0 ? parseFloat(num!) / parseFloat(den!) : 30.0;
      } else {
        fpsVal = parseFloat(fpsStr);
      }

      return { duration, width, height, fps: fpsVal };
    } catch {
      return null;
    }
  }

  private async _autoDetectMethod(
    inputPath: string,
    duration: number,
    _width: number,
    _height: number
  ): Promise<string> {
    // Analyze sample frames to decide between chromakey and rembg.
    const tempDir = path.join(
      path.dirname(inputPath),
      `.gs_detect_${Math.floor(Date.now() / 1000)}`
    );
    fs.mkdirSync(tempDir, { recursive: true });

    try {
      // Extract 5 sample frames evenly spaced
      const interval = Math.max(duration / 6, 0.1);
      const samplePaths: string[] = [];
      for (let i = 0; i < 5; i++) {
        const ts = interval * (i + 1);
        const out = path.join(tempDir, `sample_${i}.png`);
        const cmd = [
          "ffmpeg",
          "-y",
          "-ss",
          ts.toFixed(3),
          "-i",
          inputPath,
          "-frames:v",
          "1",
          out,
        ];
        try {
          await this.runCommand(cmd, { timeout: 30000 });
          if (fs.existsSync(out)) {
            samplePaths.push(out);
          }
        } catch {
          continue;
        }
      }

      if (samplePaths.length === 0) {
        return "rembg"; // fallback if we can't extract samples
      }

      // Analyze color histograms for green/blue screen presence
      const hasGreenScreen = await this._detectGreenScreenHistogram(samplePaths);

      if (!hasGreenScreen) {
        // No obvious green/blue screen detected, use rembg
        return "rembg";
      }

      // Test chromakey on a sample frame and check quality
      const testFrame = samplePaths[Math.trunc(samplePaths.length / 2)]!;
      const chromakeyQuality = await this._testChromakeyQuality(testFrame, tempDir);

      if (chromakeyQuality > 80) {
        return "chromakey";
      } else {
        return "rembg";
      }
    } finally {
      GreenScreenProcessor._cleanupDir(tempDir);
    }
  }

  private async _detectGreenScreenHistogram(samplePaths: string[]): Promise<boolean> {
    // Analyze frames for dominant green or blue channel presence.
    let greenVotes = 0;
    for (const sample of samplePaths) {
      const cmd = [
        "ffmpeg",
        "-y",
        "-i",
        sample,
        "-vf",
        "signalstats=stat=tout+vrep+brng,metadata=mode=print",
        "-frames:v",
        "1",
        "-f",
        "null",
        GreenScreenProcessor._nullDevice,
      ];
      try {
        // Check stderr for color stats (mirrors Python; result is unused beyond this).
        await this.runCommand(cmd, { timeout: 15000 }).catch(() => undefined);

        // Use a green-range filter: count green-ish pixels via colorkey alpha.
        const cmdGreen = [
          "ffmpeg",
          "-y",
          "-i",
          sample,
          "-vf",
          "colorkey=color=0x00FF00:similarity=0.4:blend=0.0," +
            "alphaextract," +
            "blackframe=amount=0:threshold=128",
          "-frames:v",
          "1",
          "-f",
          "null",
          GreenScreenProcessor._nullDevice,
        ];
        try {
          let stderr: string;
          try {
            const result2 = await this.runCommand(cmdGreen, { timeout: 15000 });
            stderr = String(result2.stderr ?? "");
          } catch (e) {
            stderr = (e as { stderr?: string }).stderr ?? "";
          }
          // blackframe reports percentage of black pixels
          // If many pixels became transparent (black in alpha), there's green
          if (stderr.includes("pblack:")) {
            const pblackMatches = [...stderr.matchAll(/pblack:(\d+)/g)].map((m) => m[1]!);
            if (pblackMatches.length > 0) {
              const pblack = parseInt(pblackMatches[0]!, 10);
              if (pblack >= 20) {
                greenVotes += 1;
              }
            }
          }
        } catch {
          /* pass */
        }
      } catch {
        continue;
      }
    }

    // If majority of frames show green screen
    return greenVotes >= Math.trunc(samplePaths.length / 2);
  }

  private async _testChromakeyQuality(testFrame: string, tempDir: string): Promise<number> {
    // Run chromakey on a test frame and estimate quality percentage (0-100).
    const keyedOut = path.join(tempDir, "chromakey_test.png");

    // Apply chromakey and output with alpha
    const cmd = [
      "ffmpeg",
      "-y",
      "-i",
      testFrame,
      "-vf",
      "chromakey=color=0x00FF00:similarity=0.3:blend=0.08",
      keyedOut,
    ];
    try {
      await this.runCommand(cmd, { timeout: 15000 });
    } catch {
      return 0.0;
    }

    if (!fs.existsSync(keyedOut)) {
      return 0.0;
    }

    // Count transparent pixels via alphaextract + blackframe
    const cmd2 = [
      "ffmpeg",
      "-y",
      "-i",
      keyedOut,
      "-vf",
      "alphaextract,blackframe=amount=0:threshold=32",
      "-frames:v",
      "1",
      "-f",
      "null",
      GreenScreenProcessor._nullDevice,
    ];
    try {
      let stderr: string;
      try {
        const result = await this.runCommand(cmd2, { timeout: 15000 });
        stderr = String(result.stderr ?? "");
      } catch (e) {
        stderr = (e as { stderr?: string }).stderr ?? "";
      }
      const pblackMatches = [...stderr.matchAll(/pblack:(\d+)/g)].map((m) => m[1]!);
      if (pblackMatches.length > 0) {
        // pblack = percentage of black pixels in alpha = transparent pixels
        return parseFloat(pblackMatches[0]!);
      }
    } catch {
      /* pass */
    }

    return 0.0;
  }

  private async _extractFrames(
    inputPath: string,
    framesDir: string,
    fps: number,
    maxFrames: number
  ): Promise<number> {
    // Extract frames from video at target fps.
    const cmd = [
      "ffmpeg",
      "-y",
      "-i",
      inputPath,
      "-vf",
      `fps=${fps}`,
      path.join(framesDir, "frame_%06d.png"),
    ];

    if (maxFrames > 0) {
      // cmd.insert(-1, ...) in Python inserts before the last element (output path)
      cmd.splice(cmd.length - 1, 0, "-frames:v", String(maxFrames));
    }

    try {
      await this.runCommand(cmd, { timeout: 600000 });
    } catch {
      // ffmpeg may return non-zero but still produce frames
    }

    // Count extracted frames
    const frameFiles = GreenScreenProcessor._globFrames(framesDir);
    const count = frameFiles.length;

    if (count > 0) {
      // Log progress for large frame counts
      if (count > 100) {
        console.log(`[green_screen_processor] Extracted ${count} frames`);
      }
    }

    return count;
  }

  private async _processChromakey(
    framesDir: string,
    processedDir: string,
    bgColor: string,
    frameCount: number
  ): Promise<boolean> {
    // Process frames using FFmpeg chromakey filter.
    const bgHex = bgColor.replace(/^#/, "");
    // Convert hex to FFmpeg color format
    const ffmpegBg = `0x${bgHex}`;

    const frameFiles = GreenScreenProcessor._globFrames(framesDir);
    let processed = 0;

    for (let i = 0; i < frameFiles.length; i++) {
      const frame = frameFiles[i]!;
      const outPath = path.join(processedDir, path.basename(frame));
      const cmd = [
        "ffmpeg",
        "-y",
        "-f",
        "lavfi",
        "-i",
        `color=c=${ffmpegBg}:size=1x1`,
        "-i",
        frame,
        "-filter_complex",
        `[0:v]scale=iw:ih[bg];` +
          `[1:v]chromakey=color=0x00FF00:similarity=0.3:blend=0.08[fg];` +
          `[bg][fg]overlay=0:0`,
        "-frames:v",
        "1",
        outPath,
      ];
      try {
        await this.runCommand(cmd, { timeout: 30000 });
        if (fs.existsSync(outPath)) {
          processed += 1;
        }
      } catch {
        // Simpler fallback: just apply chromakey without compositing
        try {
          const cmdSimple = [
            "ffmpeg",
            "-y",
            "-i",
            frame,
            "-vf",
            `chromakey=color=0x00FF00:similarity=0.3:blend=0.08`,
            outPath,
          ];
          await this.runCommand(cmdSimple, { timeout: 30000 });
          if (fs.existsSync(outPath)) {
            processed += 1;
          }
        } catch {
          continue;
        }
      }

      if (frameCount > 100 && (i + 1) % 50 === 0) {
        console.log(`[green_screen_processor] Chromakey: ${i + 1}/${frameCount} frames`);
      }
    }

    return processed > 0;
  }

  private async _processRembg(
    _framesDir: string,
    _processedDir: string,
    _bgColor: string,
    _frameCount: number
  ): Promise<boolean> {
    // rembg AI segmentation depends on the rembg package + onnxruntime/PyTorch,
    // which are excluded from this FFmpeg port. This mirrors Python's
    // `except ImportError: return False` path on a host without rembg installed.
    return false;
  }

  private async _reconstructVideo(
    framesDir: string,
    outputPath: string,
    fps: number,
    width: number,
    height: number
  ): Promise<void> {
    // Reconstruct video from processed frames using FFmpeg.
    const cmd = [
      "ffmpeg",
      "-y",
      "-framerate",
      String(fps),
      "-i",
      path.join(framesDir, "frame_%06d.png"),
      "-vf",
      `scale=${width}:${height}:flags=lanczos`,
      "-c:v",
      "libx264",
      "-crf",
      "18",
      "-preset",
      "fast",
      "-pix_fmt",
      "yuv420p",
      outputPath,
    ];
    await this.runCommand(cmd, { timeout: 600000 });
  }

  /** Sorted list of frame_*.png files in a dir (mirrors Path.glob("frame_*.png") + sorted). */
  private static _globFrames(dir: string): string[] {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return [];
    }
    return entries
      .filter((f) => /^frame_.*\.png$/.test(f))
      .sort()
      .map((f) => path.join(dir, f));
  }

  /** Recursively remove a temp directory (best-effort). */
  private static _cleanupDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      return;
    }
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
    } catch {
      /* Best-effort cleanup */
    }
  }

  override estimateRuntime(inputs: Record<string, unknown>): number {
    const method = (inputs.method as string) ?? "auto";
    if (method === "rembg") {
      return 120.0;
    } else if (method === "chromakey") {
      return 30.0;
    }
    return 60.0; // auto
  }
}
