/**
 * FFmpeg-based screen recorder (TS port of tools/capture/screen_recorder.py).
 * Cross-platform screen capture via FFmpeg native devices (gdigrab/avfoundation/x11grab).
 * subprocess -> execa; the "timeout means recording finished" behavior is preserved.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
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

type Region = { x?: number; y?: number; width: number; height: number };

async function detectAudioDeviceMac(): Promise<string | null> {
  try {
    const { stderr } = await execa("ffmpeg", ["-f", "avfoundation", "-list_devices", "true", "-i", ""], {
      timeout: 10000,
      reject: false,
    });
    let inAudio = false;
    for (const line of String(stderr ?? "").split("\n")) {
      if (line.includes("AVFoundation audio devices")) {
        inAudio = true;
        continue;
      }
      if (inAudio && line.includes("[") && line.includes("]")) {
        const idx = line.split("[")[1]?.split("]")[0]?.trim();
        if (idx && /^\d+$/.test(idx)) return idx;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function detectAudioDeviceWindows(): Promise<string | null> {
  try {
    const { stderr } = await execa("ffmpeg", ["-list_devices", "true", "-f", "dshow", "-i", "dummy"], {
      timeout: 10000,
      reject: false,
    });
    const lines = String(stderr ?? "").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i]!.toLowerCase().includes("audio") && lines[i]!.includes("DirectShow audio")) {
        for (let j = i + 1; j < Math.min(i + 10, lines.length); j += 1) {
          if (lines[j]!.includes('"') && !lines[j]!.includes("Alternative name")) {
            return lines[j]!.split('"')[1] ?? null;
          }
        }
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

export class ScreenRecorder extends BaseTool {
  override name = "screen_recorder";
  override version = "0.1.0";
  override tier = ToolTier.SOURCE;
  override capability = "screen_capture";
  override provider = "ffmpeg";
  override stability = ToolStability.BETA;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;
  override runtime = ToolRuntime.LOCAL;

  override dependencies = ["cmd:ffmpeg"];
  override install_instructions =
    "Install ffmpeg:\n  Windows: winget install ffmpeg\n  macOS: brew install ffmpeg\n  Linux: sudo apt install ffmpeg";

  override capabilities = ["record_screen", "record_screen_with_audio", "record_region"];
  override best_for = [
    "Quick screen recording without additional software",
    "Automated screen capture for demo pipelines",
    "Recording specific screen regions for tutorials",
  ];
  override not_good_for = [
    "Webcam overlay (PiP) — use Cap for that",
    "Cursor highlight effects — use Cap for that",
    "Interactive recording with pause/resume UI",
  ];

  override input_schema = {
    type: "object",
    required: ["output_path"],
    properties: {
      output_path: { type: "string", description: "Path for the output MP4 file" },
      duration_seconds: { type: "integer", default: 60, description: "Recording duration (max 600)" },
      fps: { type: "integer", default: 30, description: "Frames per second (15, 24, 30, or 60)" },
      capture_audio: { type: "boolean", default: true },
      region: {
        type: "object",
        properties: {
          x: { type: "integer" },
          y: { type: "integer" },
          width: { type: "integer" },
          height: { type: "integer" },
        },
      },
      screen_index: { type: "integer", default: 0 },
    },
  };

  override resource_profile: ResourceProfile = {
    cpu_cores: 2,
    ram_mb: 512,
    vram_mb: 0,
    disk_mb: 500,
    network_required: false,
  };
  override side_effects = ["creates_file"];
  override fallback_tools = ["cap_recorder"];

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const outputPath = inputs.output_path as string;
    const duration = Math.min((inputs.duration_seconds as number) ?? 60, 600);
    const fps = (inputs.fps as number) ?? 30;
    const captureAudio = (inputs.capture_audio as boolean) ?? true;
    const region = inputs.region as Region | undefined;
    const screenIndex = (inputs.screen_index as number) ?? 0;

    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });

    const sysPlatform = os.platform(); // 'darwin' | 'win32' | 'linux'
    const cmd = await this.buildCommand(sysPlatform, outputPath, duration, fps, captureAudio, region, screenIndex);
    if (!cmd) {
      return toolResult({
        success: false,
        error: `Screen recording not supported on ${sysPlatform}. Supported: Windows, macOS, Linux.`,
      });
    }

    const start = Date.now();
    try {
      const proc = await execa(cmd[0]!, cmd.slice(1), { timeout: (duration + 30) * 1000, reject: false });
      const elapsed = (Date.now() - start) / 1000;
      if (!fs.existsSync(outputPath)) {
        return toolResult({
          success: false,
          error: `Recording failed — no output file. FFmpeg stderr: ${String(proc.stderr ?? "").slice(-500)}`,
        });
      }
      const fileSizeMb = fs.statSync(outputPath).size / (1024 * 1024);
      const resolution = await this.probeResolution(outputPath);
      return toolResult({
        success: true,
        data: {
          output_path: outputPath,
          duration_seconds: Math.round(elapsed * 10) / 10,
          resolution,
          has_audio: captureAudio,
          file_size_mb: Math.round(fileSizeMb * 10) / 10,
          platform: sysPlatform,
          capture_method: "ffmpeg",
        },
        artifacts: [outputPath],
        duration_seconds: elapsed,
      });
    } catch (exc) {
      // execa throws on timeout — that's expected (recording ran to duration).
      if (fs.existsSync(outputPath)) {
        const fileSizeMb = fs.statSync(outputPath).size / (1024 * 1024);
        return toolResult({
          success: true,
          data: {
            output_path: outputPath,
            duration_seconds: duration,
            has_audio: captureAudio,
            file_size_mb: Math.round(fileSizeMb * 10) / 10,
            platform: sysPlatform,
            capture_method: "ffmpeg",
          },
          artifacts: [outputPath],
          duration_seconds: duration,
        });
      }
      return toolResult({ success: false, error: (exc as Error).message });
    }
  }

  private async buildCommand(
    sysPlatform: string,
    outputPath: string,
    duration: number,
    fps: number,
    captureAudio: boolean,
    region: Region | undefined,
    screenIndex: number
  ): Promise<string[] | null> {
    if (sysPlatform === "win32") {
      const cmd = ["ffmpeg", "-y", "-f", "gdigrab", "-framerate", String(fps), "-t", String(duration)];
      if (region) {
        cmd.push("-offset_x", String(region.x ?? 0), "-offset_y", String(region.y ?? 0), "-video_size", `${region.width}x${region.height}`);
      }
      cmd.push("-i", "desktop");
      if (captureAudio) {
        const dev = await detectAudioDeviceWindows();
        if (dev) cmd.push("-f", "dshow", "-i", `audio=${dev}`);
      }
      cmd.push("-c:v", "libx264", "-preset", "ultrafast", "-crf", "23");
      if (captureAudio) cmd.push("-c:a", "aac", "-b:a", "128k");
      cmd.push("-pix_fmt", "yuv420p", outputPath);
      return cmd;
    }
    if (sysPlatform === "darwin") {
      let audioIdx = "none";
      if (captureAudio) audioIdx = (await detectAudioDeviceMac()) ?? "none";
      const cmd = ["ffmpeg", "-y", "-f", "avfoundation", "-framerate", String(fps), "-t", String(duration)];
      cmd.push("-i", `${screenIndex}:${audioIdx}`);
      if (region) cmd.push("-vf", `crop=${region.width}:${region.height}:${region.x ?? 0}:${region.y ?? 0}`);
      cmd.push("-c:v", "libx264", "-preset", "ultrafast", "-crf", "23");
      if (captureAudio && audioIdx !== "none") cmd.push("-c:a", "aac", "-b:a", "128k");
      cmd.push("-pix_fmt", "yuv420p", outputPath);
      return cmd;
    }
    if (sysPlatform === "linux") {
      const display = process.env.DISPLAY ?? ":0.0";
      const cmd = ["ffmpeg", "-y", "-f", "x11grab", "-framerate", String(fps), "-t", String(duration)];
      if (region) {
        cmd.push("-video_size", `${region.width}x${region.height}`, "-i", `${display}+${region.x ?? 0},${region.y ?? 0}`);
      } else {
        cmd.push("-i", display);
      }
      if (captureAudio) cmd.push("-f", "pulse", "-i", "default");
      cmd.push("-c:v", "libx264", "-preset", "ultrafast", "-crf", "23");
      if (captureAudio) cmd.push("-c:a", "aac", "-b:a", "128k");
      cmd.push("-pix_fmt", "yuv420p", outputPath);
      return cmd;
    }
    return null;
  }

  private async probeResolution(filePath: string): Promise<string> {
    try {
      const { stdout } = await execa(
        "ffprobe",
        ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", filePath],
        { timeout: 10000, reject: false }
      );
      const parts = String(stdout ?? "").trim().split(",");
      if (parts.length === 2) return `${parts[0]}x${parts[1]}`;
    } catch {
      /* ignore */
    }
    return "unknown";
  }
}
