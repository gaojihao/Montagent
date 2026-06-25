/**
 * Cap integration tool — local Loom alternative bridge (TS port of
 * tools/capture/cap_recorder.py). Detects Cap install/status, picks up recordings.
 * subprocess (pgrep/tasklist) -> execa; pathlib/glob -> node:fs. Always AVAILABLE.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import {
  BaseTool,
  commandExists,
  Determinism,
  ExecutionMode,
  type ResourceProfile,
  type ToolResult,
  ToolRuntime,
  ToolStability,
  ToolStatus,
  ToolTier,
  toolResult,
} from "../base_tool.js";

function existsFile(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function findCapBinary(): string | null {
  const plat = os.platform();
  if (plat === "win32") {
    const candidates = [
      path.join(process.env.LOCALAPPDATA ?? "", "Cap", "Cap.exe"),
      path.join(process.env.PROGRAMFILES ?? "", "Cap", "Cap.exe"),
      path.join(process.env.LOCALAPPDATA ?? "", "Programs", "cap", "Cap.exe"),
    ];
    for (const c of candidates) if (existsFile(c)) return c;
    if (commandExists("Cap")) return "Cap";
    if (commandExists("cap")) return "cap";
  } else if (plat === "darwin") {
    const candidates = [
      "/Applications/Cap.app/Contents/MacOS/Cap",
      path.join(os.homedir(), "Applications", "Cap.app", "Contents", "MacOS", "Cap"),
    ];
    for (const c of candidates) if (existsFile(c)) return c;
  } else if (plat === "linux") {
    if (commandExists("cap")) return "cap";
    if (commandExists("Cap")) return "Cap";
    const appimage = path.join(os.homedir(), "Applications", "Cap.AppImage");
    if (existsFile(appimage)) return appimage;
  }
  return null;
}

function findCapRecordingsDir(): string | null {
  const plat = os.platform();
  if (plat === "win32") {
    const base = path.join(process.env.APPDATA ?? "", "so.cap.desktop");
    if (existsFile(base)) return base;
    const base2 = path.join(process.env.LOCALAPPDATA ?? "", "so.cap.desktop");
    if (existsFile(base2)) return base2;
  } else if (plat === "darwin") {
    const base = path.join(os.homedir(), "Library", "Application Support", "so.cap.desktop");
    if (existsFile(base)) return base;
  } else if (plat === "linux") {
    const base = path.join(os.homedir(), ".local", "share", "so.cap.desktop");
    if (existsFile(base)) return base;
  }
  return null;
}

async function isCapRunning(): Promise<boolean> {
  const plat = os.platform();
  try {
    if (plat === "win32") {
      const { stdout } = await execa("tasklist", ["/FI", "IMAGENAME eq Cap.exe", "/NH"], { timeout: 5000, reject: false });
      return String(stdout ?? "").includes("Cap.exe");
    }
    if (plat === "darwin") {
      const { exitCode } = await execa("pgrep", ["-x", "Cap"], { timeout: 5000, reject: false });
      return exitCode === 0;
    }
    if (plat === "linux") {
      const { exitCode } = await execa("pgrep", ["-x", "cap"], { timeout: 5000, reject: false });
      return exitCode === 0;
    }
  } catch {
    /* ignore */
  }
  return false;
}

interface Recording {
  path: string;
  name: string;
  size_mb: number;
  modified: number;
}

function getRecentRecordings(recordingsDir: string, sinceSeconds = 300): Recording[] {
  const recordings: Recording[] = [];
  const cutoff = Date.now() / 1000 - sinceSeconds;
  let items: string[];
  try {
    items = fs.readdirSync(recordingsDir);
  } catch {
    return [];
  }
  const dirs = items
    .map((n) => path.join(recordingsDir, n))
    .filter((p) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  for (const item of dirs) {
    const candidates = [
      ...safeGlobMp4(item),
      ...safeGlobMp4(path.join(item, "output")),
    ];
    for (const video of candidates) {
      const st = fs.statSync(video);
      if (st.mtimeMs / 1000 > cutoff) {
        recordings.push({
          path: video,
          name: path.basename(item),
          size_mb: Math.round((st.size / (1024 * 1024)) * 10) / 10,
          modified: st.mtimeMs / 1000,
        });
      }
    }
  }
  return recordings.slice(0, 10);
}

function safeGlobMp4(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith(".mp4"))
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

export class CapRecorder extends BaseTool {
  override name = "cap_recorder";
  override version = "0.1.0";
  override tier = ToolTier.SOURCE;
  override capability = "screen_capture";
  override provider = "cap";
  override stability = ToolStability.BETA;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;
  override runtime = ToolRuntime.LOCAL;

  override dependencies: string[] = []; // graceful detection, no hard deps
  override install_instructions =
    "Cap is a free, open-source Loom alternative.\n\nInstall from: https://cap.so/download\n" +
    "  - Windows: Download and run the installer\n  - macOS: brew install --cask cap\n" +
    "  - Linux: Download the AppImage from GitHub releases\n\nSource: https://github.com/CapSoftware/cap";

  override capabilities = ["detect_cap", "check_status", "find_recordings", "setup_guidance"];
  override best_for = [
    "Professional screen recordings with webcam overlay",
    "Cursor highlight and click effect recordings",
    "Recording with a visual UI (not CLI-driven)",
    "Recordings that need polished audio capture",
  ];
  override not_good_for = [
    "Automated/headless screen recording",
    "Recording without user interaction",
    "Quick recordings where setup time matters",
  ];

  override input_schema = {
    type: "object",
    required: ["operation"],
    properties: {
      operation: {
        type: "string",
        enum: ["detect", "status", "find_recordings", "setup_guide", "pick_latest"],
      },
      output_dir: { type: "string" },
      since_minutes: { type: "integer", default: 5 },
    },
  };

  override resource_profile: ResourceProfile = {
    cpu_cores: 1,
    ram_mb: 64,
    vram_mb: 0,
    disk_mb: 0,
    network_required: false,
  };
  override side_effects = [];
  override fallback_tools = ["screen_recorder"];

  override getStatus(): ToolStatus {
    return ToolStatus.AVAILABLE; // gracefully handles missing Cap
  }

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const operation = inputs.operation as string;
    switch (operation) {
      case "detect":
        return this.detect();
      case "status":
        return this.status();
      case "find_recordings":
        return this.findRecordings((inputs.since_minutes as number) ?? 5);
      case "setup_guide":
        return this.setupGuide();
      case "pick_latest":
        return this.pickLatest(inputs.output_dir as string | undefined);
      default:
        return toolResult({
          success: false,
          error: `Unknown operation: ${operation}. Valid: detect, status, find_recordings, setup_guide, pick_latest`,
        });
    }
  }

  private async detect(): Promise<ToolResult> {
    const binary = findCapBinary();
    const recordingsDir = findCapRecordingsDir();
    const running = binary ? await isCapRunning() : false;
    return toolResult({
      success: true,
      data: {
        installed: binary !== null,
        running,
        binary_path: binary,
        recordings_dir: recordingsDir,
        platform: os.platform(),
      },
    });
  }

  private async status(): Promise<ToolResult> {
    const binary = findCapBinary();
    if (!binary) {
      return toolResult({
        success: true,
        data: { installed: false, running: false, message: "Cap is not installed. Use operation='setup_guide'." },
      });
    }
    const running = await isCapRunning();
    const recordingsDir = findCapRecordingsDir();
    return toolResult({
      success: true,
      data: {
        installed: true,
        running,
        binary_path: binary,
        recordings_dir: recordingsDir,
        message: running ? "Cap is running and ready to record." : "Cap is installed but not running.",
      },
    });
  }

  private findRecordings(sinceMinutes: number): ToolResult {
    const recordingsDir = findCapRecordingsDir();
    if (!recordingsDir) {
      return toolResult({ success: true, data: { recordings: [], message: "Cap recordings directory not found." } });
    }
    const recordings = getRecentRecordings(recordingsDir, sinceMinutes * 60);
    return toolResult({
      success: true,
      data: {
        recordings,
        recordings_dir: recordingsDir,
        count: recordings.length,
        message: recordings.length
          ? `Found ${recordings.length} recording(s) from the last ${sinceMinutes} minutes.`
          : `No recordings found in the last ${sinceMinutes} minutes.`,
      },
    });
  }

  private setupGuide(): ToolResult {
    const plat = os.platform();
    const binary = findCapBinary();
    if (binary) {
      return toolResult({
        success: true,
        data: { installed: true, binary_path: binary, message: "Cap is already installed!" },
      });
    }
    const instructions: Record<string, { recommended: string; alternative: string; time_estimate: string }> = {
      win32: { recommended: "Download from https://cap.so/download", alternative: "winget install CapSoftware.Cap", time_estimate: "2 minutes" },
      darwin: { recommended: "brew install --cask cap", alternative: "Download .dmg from https://cap.so/download", time_estimate: "2 minutes" },
      linux: { recommended: "Download AppImage from https://github.com/CapSoftware/cap/releases", alternative: "Build from source", time_estimate: "3-5 minutes" },
    };
    const guide = instructions[plat] ?? instructions.linux!;
    return toolResult({
      success: true,
      data: {
        installed: false,
        platform: plat,
        setup: guide,
        what_you_get: [
          "Webcam overlay (picture-in-picture)",
          "Cursor highlight and click effects",
          "Clean system + microphone audio capture",
          "Built-in editor with auto-captions",
          "Polished recording UI",
        ],
        source_code: "https://github.com/CapSoftware/cap",
        message: `Cap is not installed. Setup takes about ${guide.time_estimate}.`,
      },
    });
  }

  private pickLatest(outputDir: string | undefined): ToolResult {
    const recordingsDir = findCapRecordingsDir();
    if (!recordingsDir) return toolResult({ success: false, error: "Cap recordings directory not found." });
    const recordings = getRecentRecordings(recordingsDir, 3600);
    if (recordings.length === 0)
      return toolResult({ success: false, error: "No recent Cap recordings found. Record something in Cap first." });
    const latest = recordings[0]!;
    const source = latest.path;
    if (outputDir) {
      const dest = path.join(outputDir, path.basename(source));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(source, dest);
      return toolResult({
        success: true,
        data: { output_path: dest, original_path: source, size_mb: latest.size_mb, capture_method: "cap" },
        artifacts: [dest],
      });
    }
    return toolResult({
      success: true,
      data: { output_path: source, size_mb: latest.size_mb, capture_method: "cap" },
      artifacts: [source],
    });
  }
}
