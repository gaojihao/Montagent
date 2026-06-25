/**
 * Auto-reframe tool for aspect ratio conversion with face tracking.
 *
 * TypeScript port of tools/video/auto_reframe.py. Converts video between aspect
 * ratios (e.g. 16:9 → 9:16 for Instagram Reels) while keeping the speaker's
 * face centered in frame.
 *
 * Approach: face detection -> smoothed bounding box trajectory -> FFmpeg crop
 * filter. No GPU required.
 *
 * Parity notes vs. Python:
 *  - The ffprobe invocation, the crop/scale/sendcmd filter strings, and the
 *    ffmpeg encode argument arrays are copied verbatim.
 *  - Internal face detection in Python imported tools.analysis.face_tracker
 *    (MediaPipe/OpenCV) inside a try/except that fell back to center-crop when
 *    unavailable. That CV tool is not part of this FFmpeg port (and is GPU/CV
 *    territory excluded here), so the internal-detection branch always yields no
 *    faces -> center_crop — behaviorally identical to running Python without
 *    MediaPipe/OpenCV installed. Pre-computed face_tracking_json is still fully
 *    honored, exercising the face_tracked code paths verbatim.
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

// Common target aspect ratios
const ASPECT_PRESETS: Record<string, [number, number]> = {
  portrait: [9, 16], // Instagram Reels, TikTok, YouTube Shorts
  square: [1, 1], // Instagram Feed
  landscape: [16, 9], // YouTube, LinkedIn
  cinematic: [21, 9], // Ultra-wide
  vertical_4_5: [4, 5], // Instagram portrait post
};

interface FaceBBox {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface FaceEntry {
  bbox: FaceBBox;
  timestamp_seconds: number;
}

/** Reproduce Python's Path.with_stem: replace the filename stem, keep dir + suffix. */
function withStem(p: string, newStem: string): string {
  const dir = path.dirname(p);
  const ext = path.extname(p);
  return path.join(dir, `${newStem}${ext}`);
}

export class AutoReframe extends BaseTool {
  override name = "auto_reframe";
  override version = "0.1.0";
  override tier = ToolTier.CORE;
  override capability = "video_post";
  override provider = "ffmpeg";
  override stability = ToolStability.EXPERIMENTAL;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;

  override dependencies = ["cmd:ffmpeg"];
  override install_instructions =
    "FFmpeg is required. For face-tracked reframing, also install:\n" +
    "pip install mediapipe opencv-python\n\n" +
    "Without MediaPipe/OpenCV, falls back to center-crop.";
  override agent_skills = ["ffmpeg"];

  override capabilities = [
    "aspect_ratio_conversion",
    "face_tracked_crop",
    "smart_reframe",
    "center_crop",
  ];

  override input_schema = {
    type: "object",
    required: ["input_path"],
    properties: {
      input_path: { type: "string" },
      output_path: { type: "string" },
      target_aspect: {
        type: "string",
        enum: Object.keys(ASPECT_PRESETS),
        default: "portrait",
        description: "Target aspect ratio preset",
      },
      target_width: {
        type: "integer",
        description: "Explicit target width (overrides preset)",
      },
      target_height: {
        type: "integer",
        description: "Explicit target height (overrides preset)",
      },
      face_tracking_json: {
        type: "string",
        description:
          "Path to pre-computed face_tracker JSON. If omitted, runs face detection internally.",
      },
      smoothing_window: {
        type: "integer",
        default: 15,
        minimum: 1,
        description:
          "Number of frames for position smoothing (higher = smoother pan, lower = more responsive)",
      },
      face_padding: {
        type: "number",
        default: 0.4,
        minimum: 0.0,
        maximum: 1.0,
        description: "Extra space around face as fraction of face size (0.4 = 40% padding)",
      },
      sample_fps: {
        type: "number",
        default: 5,
        description: "Face detection sample rate (only used if no face_tracking_json)",
      },
      codec: { type: "string", default: "libx264" },
      crf: { type: "integer", default: 18 },
    },
  };

  override resource_profile: ResourceProfile = {
    cpu_cores: 4,
    ram_mb: 2048,
    vram_mb: 0,
    disk_mb: 4000,
    network_required: false,
  };
  override retry_policy: RetryPolicy = {
    max_retries: 1,
    backoff_seconds: 1.0,
    retryable_errors: ["FFmpeg error"],
  };
  override resume_support = ResumeSupport.FROM_START;
  override idempotency_key_fields = [
    "input_path",
    "target_aspect",
    "target_width",
    "target_height",
    "smoothing_window",
    "face_padding",
  ];
  override side_effects = ["writes reframed video to output_path"];
  override user_visible_verification = [
    "Play reframed output — verify face stays centered and framing is smooth",
    "Check that no important content is cropped out",
  ];

  override async execute(inputs: Record<string, any>): Promise<ToolResult> {
    const inputPath = inputs.input_path as string;
    if (!fs.existsSync(inputPath)) {
      return toolResult({ success: false, error: `Input not found: ${inputPath}` });
    }

    const start = Date.now();

    // Get source video dimensions
    const [srcW, srcH, srcFps] = await this._getVideoInfo(inputPath);
    if (srcW === 0 || srcH === 0) {
      return toolResult({ success: false, error: "Could not read video dimensions" });
    }

    // Determine target crop dimensions (in source pixel space)
    const [targetW, targetH] = this._computeCropSize(inputs, srcW, srcH);

    // If source already matches target aspect, no crop needed
    if (targetW === srcW && targetH === srcH) {
      return toolResult({
        success: true,
        data: {
          message: "Source already matches target aspect ratio",
          output: inputPath,
        },
        artifacts: [inputPath],
      });
    }

    // Get face tracking data
    const faceData = await this._getFaceData(inputs, inputPath, srcFps);

    // Compute per-frame crop positions
    let cropX: number | number[];
    let cropY: number | number[];
    let method: string;
    if (faceData && faceData.length > 0) {
      [cropX, cropY] = this._computeFaceTrackedCrop(
        faceData,
        srcW,
        srcH,
        targetW,
        targetH,
        srcFps,
        inputs.smoothing_window ?? 15,
        inputs.face_padding ?? 0.4
      );
      method = "face_tracked";
    } else {
      // Fallback: center crop
      cropX = Math.trunc((srcW - targetW) / 2);
      cropY = Math.trunc((srcH - targetH) / 2);
      method = "center_crop";
    }

    // Determine output resolution
    const [outW, outH] = this._computeOutputResolution(inputs, targetW, targetH, srcW, srcH);

    // Build output path
    const aspectName = (inputs.target_aspect as string) ?? "portrait";
    const outputPath =
      (inputs.output_path as string) ??
      withStem(inputPath, `${path.basename(inputPath, path.extname(inputPath))}_${aspectName}`);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    // Render via FFmpeg
    const codec = (inputs.codec as string) ?? "libx264";
    const crf = inputs.crf ?? 18;

    let result: ToolResult;
    if (method === "face_tracked" && Array.isArray(cropX)) {
      // Dynamic crop: write crop coordinates to a file and use sendcmd
      result = await this._renderDynamicCrop(
        inputPath,
        outputPath,
        cropX,
        cropY as number[],
        targetW,
        targetH,
        outW,
        outH,
        srcFps,
        codec,
        crf
      );
    } else {
      // Static crop
      result = await this._renderStaticCrop(
        inputPath,
        outputPath,
        cropX as number,
        cropY as number,
        targetW,
        targetH,
        outW,
        outH,
        codec,
        crf
      );
    }

    if (!result.success) {
      return result;
    }

    const elapsed = (Date.now() - start) / 1000;

    return toolResult({
      success: true,
      data: {
        input: inputPath,
        output: outputPath,
        source_resolution: `${srcW}x${srcH}`,
        crop_resolution: `${targetW}x${targetH}`,
        output_resolution: `${outW}x${outH}`,
        method,
        target_aspect: (inputs.target_aspect as string) ?? "portrait",
      },
      artifacts: [outputPath],
      duration_seconds: Math.round(elapsed * 100) / 100,
    });
  }

  private async _getVideoInfo(p: string): Promise<[number, number, number]> {
    // Get video width, height, fps via ffprobe.
    const cmd = [
      "ffprobe",
      "-v",
      "quiet",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,r_frame_rate",
      "-of",
      "json",
      p,
    ];
    try {
      const result = await this.runCommand(cmd);
      const data = JSON.parse(String(result.stdout)) as {
        streams: Array<{ width: number; height: number; r_frame_rate: string }>;
      };
      const stream = data.streams[0]!;
      const w = Math.trunc(Number(stream.width));
      const h = Math.trunc(Number(stream.height));
      // Parse r_frame_rate (e.g. "30000/1001")
      const fpsParts = stream.r_frame_rate.split("/");
      const fps =
        fpsParts.length === 2
          ? parseFloat(fpsParts[0]!) / parseFloat(fpsParts[1]!)
          : parseFloat(fpsParts[0]!);
      return [w, h, fps];
    } catch {
      return [0, 0, 30.0];
    }
  }

  private _computeCropSize(
    inputs: Record<string, any>,
    srcW: number,
    srcH: number
  ): [number, number] {
    // Compute crop dimensions in source pixel space that match the target aspect ratio.
    let tw: number;
    let th: number;
    if ("target_width" in inputs && "target_height" in inputs) {
      // Explicit dimensions — compute crop in source space matching this ratio
      tw = inputs.target_width;
      th = inputs.target_height;
    } else {
      const aspectName = (inputs.target_aspect as string) ?? "portrait";
      [tw, th] = ASPECT_PRESETS[aspectName] ?? [9, 16];
    }

    const targetRatio = tw / th;
    const srcRatio = srcW / srcH;

    let cropW: number;
    let cropH: number;
    if (targetRatio > srcRatio) {
      // Target is wider — crop height
      cropW = srcW;
      cropH = Math.trunc(srcW / targetRatio);
    } else {
      // Target is taller/narrower — crop width
      cropH = srcH;
      cropW = Math.trunc(srcH * targetRatio);
    }

    // Ensure even dimensions (required by most codecs)
    cropW = cropW - (cropW % 2);
    cropH = cropH - (cropH % 2);

    return [cropW, cropH];
  }

  private _computeOutputResolution(
    inputs: Record<string, any>,
    cropW: number,
    cropH: number,
    _srcW: number,
    _srcH: number
  ): [number, number] {
    // Determine final output resolution. Scales to standard sizes.
    let outW: number;
    let outH: number;
    if ("target_width" in inputs && "target_height" in inputs) {
      outW = inputs.target_width;
      outH = inputs.target_height;
    } else {
      const aspectName = (inputs.target_aspect as string) ?? "portrait";
      if (aspectName === "portrait") {
        [outW, outH] = [1080, 1920];
      } else if (aspectName === "square") {
        [outW, outH] = [1080, 1080];
      } else if (aspectName === "landscape") {
        [outW, outH] = [1920, 1080];
      } else if (aspectName === "cinematic") {
        [outW, outH] = [2560, 1080];
      } else if (aspectName === "vertical_4_5") {
        [outW, outH] = [1080, 1350];
      } else {
        [outW, outH] = [cropW, cropH];
      }
    }

    // Ensure even
    outW = outW - (outW % 2);
    outH = outH - (outH % 2);
    return [outW, outH];
  }

  private async _getFaceData(
    inputs: Record<string, any>,
    _inputPath: string,
    _srcFps: number
  ): Promise<FaceEntry[]> {
    // Get face tracking data — from pre-computed JSON or by running detection.
    // Check for pre-computed tracking data
    const trackingJson = inputs.face_tracking_json as string | undefined;
    if (trackingJson) {
      if (fs.existsSync(trackingJson)) {
        const data = JSON.parse(fs.readFileSync(trackingJson, "utf-8")) as {
          faces?: FaceEntry[];
        };
        return data.faces ?? [];
      }
    }

    // Internal face detection requires the MediaPipe/OpenCV-backed face_tracker
    // (CV/GPU tool, not part of this FFmpeg port). Mirrors the Python try/except
    // fallback when MediaPipe/OpenCV is unavailable: no faces -> center crop.
    return [];
  }

  private _computeFaceTrackedCrop(
    faces: FaceEntry[],
    srcW: number,
    srcH: number,
    cropW: number,
    cropH: number,
    _fps: number,
    smoothingWindow: number,
    _facePadding: number
  ): [number | number[], number | number[]] {
    // Compute smoothed crop positions from face tracking data.
    // Returns a single (x, y) if face positions are stable enough,
    // or lists of per-frame positions for dynamic cropping.
    if (faces.length === 0) {
      const cx = Math.trunc((srcW - cropW) / 2);
      const cy = Math.trunc((srcH - cropH) / 2);
      return [cx, cy];
    }

    // Convert relative bbox centers to pixel positions
    const faceCentersX: number[] = [];
    const faceCentersY: number[] = [];

    for (const f of faces) {
      const bbox = f.bbox;
      // Center of face in pixel space
      const centerX = (bbox.x + bbox.width / 2) * srcW;
      const centerY = (bbox.y + bbox.height / 2) * srcH;
      faceCentersX.push(centerX);
      faceCentersY.push(centerY);
    }

    // Check if face position is stable (talking head usually is)
    const xRange = Math.max(...faceCentersX) - Math.min(...faceCentersX);
    const yRange = Math.max(...faceCentersY) - Math.min(...faceCentersY);

    // If face barely moves (<10% of frame), use a single static crop
    if (xRange < srcW * 0.1 && yRange < srcH * 0.1) {
      const avgX = faceCentersX.reduce((a, b) => a + b, 0) / faceCentersX.length;
      const avgY = faceCentersY.reduce((a, b) => a + b, 0) / faceCentersY.length;

      // Position crop window centered on face, with bias toward upper third
      let cropX = Math.trunc(avgX - cropW / 2);
      let cropY = Math.trunc(avgY - cropH * 0.35); // Face in upper 35% of frame

      // Clamp to frame bounds
      cropX = Math.max(0, Math.min(cropX, srcW - cropW));
      cropY = Math.max(0, Math.min(cropY, srcH - cropH));

      return [cropX, cropY];
    }

    // Dynamic crop: smooth the trajectory
    const smoothedX = this._smoothPositions(faceCentersX, smoothingWindow);
    const smoothedY = this._smoothPositions(faceCentersY, smoothingWindow);

    // Convert to crop positions (top-left corner), clamped
    const cropXs: number[] = [];
    const cropYs: number[] = [];
    for (let i = 0; i < smoothedX.length; i++) {
      const sx = smoothedX[i]!;
      const sy = smoothedY[i]!;
      let cx = Math.trunc(sx - cropW / 2);
      let cy = Math.trunc(sy - cropH * 0.35);
      cx = Math.max(0, Math.min(cx, srcW - cropW));
      cy = Math.max(0, Math.min(cy, srcH - cropH));
      cropXs.push(cx);
      cropYs.push(cy);
    }

    return [cropXs, cropYs];
  }

  private _smoothPositions(values: number[], window: number): number[] {
    // Simple moving average smoothing.
    const smoothed: number[] = [];
    for (let i = 0; i < values.length; i++) {
      const start = Math.max(0, i - Math.trunc(window / 2));
      const end = Math.min(values.length, i + Math.trunc(window / 2) + 1);
      let sum = 0;
      for (let j = start; j < end; j++) {
        sum += values[j]!;
      }
      smoothed.push(sum / (end - start));
    }
    return smoothed;
  }

  private async _renderStaticCrop(
    inputPath: string,
    outputPath: string,
    cropX: number,
    cropY: number,
    cropW: number,
    cropH: number,
    outW: number,
    outH: number,
    codec: string,
    crf: number
  ): Promise<ToolResult> {
    // Render with a static crop position.
    const vf = `crop=${cropW}:${cropH}:${cropX}:${cropY},scale=${outW}:${outH}`;

    const cmd = [
      "ffmpeg",
      "-y",
      "-i",
      inputPath,
      "-vf",
      vf,
      "-c:v",
      codec,
      "-crf",
      String(crf),
      "-preset",
      "fast",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      outputPath,
    ];

    try {
      await this.runCommand(cmd, { timeout: 600000 });
    } catch (e) {
      return toolResult({ success: false, error: `FFmpeg render failed: ${(e as Error).message ?? e}` });
    }

    return toolResult({ success: true });
  }

  private async _renderDynamicCrop(
    inputPath: string,
    outputPath: string,
    cropXs: number[],
    cropYs: number[],
    cropW: number,
    cropH: number,
    outW: number,
    outH: number,
    fps: number,
    codec: string,
    crf: number
  ): Promise<ToolResult> {
    // Render with dynamic crop positions that follow the face.
    // Uses FFmpeg's sendcmd filter to update crop position over time.
    if (cropXs.length === 0) {
      return toolResult({ success: false, error: "No crop positions computed" });
    }

    // If very few data points, fall back to static using average
    if (cropXs.length < 3) {
      const avgX = Math.trunc(cropXs.reduce((a, b) => a + b, 0) / cropXs.length);
      const avgY = Math.trunc(cropYs.reduce((a, b) => a + b, 0) / cropYs.length);
      return this._renderStaticCrop(
        inputPath,
        outputPath,
        avgX,
        avgY,
        cropW,
        cropH,
        outW,
        outH,
        codec,
        crf
      );
    }

    // Build sendcmd script for crop filter position updates
    // Each command sets the crop x,y at the corresponding timestamp
    const tempDir = path.join(path.dirname(outputPath), ".reframe_tmp");
    fs.mkdirSync(tempDir, { recursive: true });
    const sendcmdPath = path.join(tempDir, "crop_commands.txt");

    // Approximate timestamps from the face tracking sample rate
    // The face data was sampled at sample_fps intervals
    const sampleInterval = 1.0 / (fps / Math.max(1, Math.trunc(fps / 5))); // Approximate

    const lines: string[] = [];
    for (let i = 0; i < cropXs.length; i++) {
      const ts = i * sampleInterval;
      lines.push(`${ts.toFixed(3)} [enter] crop x ${cropXs[i]};`);
      lines.push(`${ts.toFixed(3)} [enter] crop y ${cropYs[i]};`);
    }

    fs.writeFileSync(sendcmdPath, lines.join("\n"), { encoding: "utf-8" });

    // Use crop with sendcmd for dynamic positioning
    const vf =
      `sendcmd=f='${sendcmdPath.replace(/\\/g, "/")}':flags=enter,` +
      `crop=${cropW}:${cropH}:${cropXs[0]}:${cropYs[0]},` +
      `scale=${outW}:${outH}`;

    const cmd = [
      "ffmpeg",
      "-y",
      "-i",
      inputPath,
      "-vf",
      vf,
      "-c:v",
      codec,
      "-crf",
      String(crf),
      "-preset",
      "fast",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      outputPath,
    ];

    try {
      await this.runCommand(cmd, { timeout: 600000 });
    } catch {
      // sendcmd can be finicky — fall back to static crop with average position
      const avgX = Math.trunc(cropXs.reduce((a, b) => a + b, 0) / cropXs.length);
      const avgY = Math.trunc(cropYs.reduce((a, b) => a + b, 0) / cropYs.length);
      const result = await this._renderStaticCrop(
        inputPath,
        outputPath,
        avgX,
        avgY,
        cropW,
        cropH,
        outW,
        outH,
        codec,
        crf
      );
      if (result.success) {
        result.data = result.data ?? {};
        result.data.fallback = "sendcmd failed, used static average crop";
      }
      // Clean up before returning
      this._cleanupSendcmd(sendcmdPath, tempDir);
      return result;
    }

    // Clean up
    this._cleanupSendcmd(sendcmdPath, tempDir);

    return toolResult({ success: true });
  }

  private _cleanupSendcmd(sendcmdPath: string, tempDir: string): void {
    if (fs.existsSync(sendcmdPath)) {
      try {
        fs.unlinkSync(sendcmdPath);
      } catch {
        /* best effort */
      }
    }
    try {
      fs.rmdirSync(tempDir);
    } catch {
      /* OSError — best effort */
    }
  }

  override estimateRuntime(_inputs: Record<string, unknown>): number {
    // Estimate runtime in seconds. Roughly 1x realtime for face tracking + render.
    return 60.0; // Conservative default
  }

  /** Return available aspect ratio presets. */
  static listPresets(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, [w, h]] of Object.entries(ASPECT_PRESETS)) {
      out[name] = `${w}:${h}`;
    }
    return out;
  }
}
