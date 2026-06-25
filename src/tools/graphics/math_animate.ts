/**
 * Mathematical animation tool via ManimCE.
 *
 * TypeScript port of tools/graphics/math_animate.py. Generates animated
 * math/science/explainer videos from Python Manim scene code using the Manim
 * Community Edition engine — a Python CLI (`manim`) invoked as a subprocess.
 * Free, local, no API key required.
 *
 * Parity notes vs. Python:
 *  - Manim is and remains a Python CLI; only the `subprocess.run([...])`
 *    invocation is translated to `this.runCommand([...])` (execa). The CLI
 *    argument vector (quality flag, --format, -s, --transparent,
 *    --background_color, --disable_caching, extra args, scene file, scene name)
 *    is built identically.
 *  - QUALITY_PRESETS, the scene-name regex, the media/ recursive output search,
 *    and the ffprobe JSON probe are copied verbatim.
 *  - dependencies=["cmd:manim"], runtime LOCAL. Without the manim binary the
 *    tool reports UNAVAILABLE (matches the Python shutil.which("manim") check).
 *  - subprocess timeout (300s) is preserved via runCommand({ timeout: 300_000 }).
 *    execa raises on timeout; we map that to the Python TimeoutExpired branch.
 *  - tempfile.mkdtemp(prefix="manim_") -> fs.mkdtempSync(<tmpdir>/manim_).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BaseTool,
  Determinism,
  ExecutionMode,
  ResourceProfile,
  RetryPolicy,
  ToolResult,
  ToolRuntime,
  ToolStability,
  ToolStatus,
  ToolTier,
  commandExists,
  toolResult,
} from "../base_tool.js";

// Quality presets mapping to Manim CLI flags
interface QualityPreset {
  flag: string;
  resolution: string;
  fps: number;
}

export const QUALITY_PRESETS: Record<string, QualityPreset> = {
  low: { flag: "-ql", resolution: "854x480", fps: 15 },
  medium: { flag: "-qm", resolution: "1280x720", fps: 30 },
  high: { flag: "-qh", resolution: "1920x1080", fps: 60 },
  "4k": { flag: "-qk", resolution: "3840x2160", fps: 60 },
  preview: { flag: "-ql --format gif", resolution: "854x480", fps: 15 },
};

export class MathAnimate extends BaseTool {
  override name = "math_animate";
  override version = "0.1.0";
  override tier = ToolTier.GENERATE;
  override capability = "graphics";
  override provider = "manim";
  override stability = ToolStability.EXPERIMENTAL;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;
  override runtime = ToolRuntime.LOCAL;

  override dependencies = ["cmd:manim"];
  override install_instructions =
    "Install ManimCE:\n" +
    "  pip install manim\n" +
    "  manim checkhealth\n" +
    "Requires: Python 3.8+, FFmpeg, LaTeX (optional, for math formulas)\n" +
    "  Windows: choco install miktex ffmpeg\n" +
    "  macOS: brew install mactex ffmpeg\n" +
    "  Linux: sudo apt install texlive-full ffmpeg";
  override agent_skills = ["manimce-best-practices", "manim-composer"];

  override capabilities = [
    "render_scene",
    "render_from_code",
    "render_from_template",
  ];

  override input_schema = {
    type: "object",
    required: ["scene_code"],
    properties: {
      scene_code: {
        type: "string",
        description:
          "Python code defining a Manim scene. Must contain a class " +
          "inheriting from Scene with a construct() method. " +
          "Import 'from manim import *' is auto-added if missing.",
      },
      scene_name: {
        type: "string",
        description:
          "Name of the Scene class to render. Auto-detected if only one scene.",
      },
      quality: {
        type: "string",
        enum: Object.keys(QUALITY_PRESETS),
        default: "medium",
        description: "Render quality preset",
      },
      format: {
        type: "string",
        enum: ["mp4", "gif", "png", "webm"],
        default: "mp4",
      },
      output_path: { type: "string" },
      transparent: {
        type: "boolean",
        default: false,
        description:
          "Render with transparent background (PNG sequence or WebM)",
      },
      background_color: {
        type: "string",
        description:
          "Background hex color (e.g., '#1a1a2e'). Default: Manim default (black).",
      },
      extra_args: {
        type: "array",
        items: { type: "string" },
        description: "Additional Manim CLI arguments",
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
  override retry_policy: RetryPolicy = {
    max_retries: 1,
    backoff_seconds: 1.0,
    retryable_errors: ["timeout"],
  };
  override idempotency_key_fields = ["scene_code", "scene_name", "quality"];
  override side_effects = [
    "writes video/image file to output_path",
    "creates temp files",
  ];
  override user_visible_verification = [
    "Watch the animation for correctness and visual quality",
    "Verify math formulas render correctly (requires LaTeX)",
  ];

  override getStatus(): ToolStatus {
    if (commandExists("manim")) {
      return ToolStatus.AVAILABLE;
    }
    return ToolStatus.UNAVAILABLE;
  }

  override estimateCost(_inputs: Record<string, unknown>): number {
    return 0.0; // local, free
  }

  override estimateRuntime(inputs: Record<string, unknown>): number {
    const quality = (inputs.quality as string) ?? "medium";
    // Rough estimates based on scene complexity (assuming ~10s scene)
    const estimates: Record<string, number> = {
      low: 5.0,
      medium: 15.0,
      high: 45.0,
      "4k": 120.0,
      preview: 3.0,
    };
    return estimates[quality] ?? 15.0;
  }

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    if (!commandExists("manim")) {
      return toolResult({
        success: false,
        error: "Manim not found. " + this.install_instructions,
      });
    }

    const start = Date.now();

    let result: ToolResult;
    try {
      result = await this.render(inputs);
    } catch (e) {
      return toolResult({
        success: false,
        error: `Manim render failed: ${(e as Error).message ?? e}`,
      });
    }

    result.duration_seconds = Math.round((Date.now() - start) / 10) / 100;
    return result;
  }

  private async render(inputs: Record<string, unknown>): Promise<ToolResult> {
    let sceneCode = inputs.scene_code as string;
    let sceneName = inputs.scene_name as string | undefined;
    const quality = (inputs.quality as string) ?? "medium";
    const outputFormat = (inputs.format as string) ?? "mp4";
    const outputPath = inputs.output_path as string | undefined;
    const transparent = (inputs.transparent as boolean) ?? false;
    const bgColor = inputs.background_color as string | undefined;
    const extraArgs = (inputs.extra_args as string[]) ?? [];

    // Ensure import statement
    if (!sceneCode.includes("from manim import")) {
      sceneCode = "from manim import *\n\n" + sceneCode;
    }

    // Auto-detect scene name if not provided
    if (!sceneName) {
      const detected = this.detectSceneName(sceneCode);
      if (!detected) {
        return toolResult({
          success: false,
          error:
            "Could not detect Scene class name. Provide scene_name explicitly.",
        });
      }
      sceneName = detected;
    }

    // Write scene code to temp file
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "manim_"));
    const sceneFile = path.join(workDir, "scene.py");
    fs.writeFileSync(sceneFile, sceneCode, { encoding: "utf-8" });

    // Build Manim CLI command
    const cmd: string[] = ["manim"];

    // Quality flag
    const preset = QUALITY_PRESETS[quality] ?? QUALITY_PRESETS["medium"]!;
    for (const flagPart of preset.flag.split(/\s+/)) {
      cmd.push(flagPart);
    }

    // Format
    if (outputFormat === "gif") {
      cmd.push("--format");
      cmd.push("gif");
    } else if (outputFormat === "webm") {
      cmd.push("--format");
      cmd.push("webm");
    } else if (outputFormat === "png") {
      cmd.push("-s"); // save last frame as PNG
    }

    // Transparent background
    if (transparent) {
      cmd.push("--transparent");
    }

    // Background color
    if (bgColor) {
      cmd.push("--background_color", bgColor);
    }

    // Disable window preview (headless rendering)
    cmd.push("--disable_caching");

    // Extra args
    cmd.push(...extraArgs);

    // Scene file and class name
    cmd.push(sceneFile);
    cmd.push(sceneName);

    // Execute Manim
    let proc;
    try {
      proc = await this.runCommand(cmd, { timeout: 300_000, cwd: workDir });
    } catch (e) {
      const err = e as {
        timedOut?: boolean;
        stderr?: unknown;
        stdout?: unknown;
        exitCode?: number;
      };
      // Map execa timeout to the Python TimeoutExpired branch.
      if (err.timedOut) {
        this.cleanup(workDir);
        return toolResult({
          success: false,
          error:
            "Manim render timed out after 300s. Try 'low' or 'preview' quality.",
        });
      }

      // Non-zero exit (execa throws): mirror the Python returncode != 0 branch.
      const stderr = String(err.stderr ?? "");
      const stdout = String(err.stdout ?? "");
      let errorMsg = stderr || stdout || "Unknown error";
      const lines = errorMsg.trim().split("\n");
      const errorLines = lines.filter(
        (l) => l.includes("Error") || l.includes("error") || l.includes("Traceback")
      );
      if (errorLines.length > 0) {
        errorMsg = lines.slice(lines.indexOf(errorLines[0]!)).join("\n");
      }
      this.cleanup(workDir);
      return toolResult({
        success: false,
        error: `Manim render failed:\n${errorMsg}`,
        data: { full_stderr: stderr, full_stdout: stdout },
      });
    }

    const procStdout = String(proc.stdout ?? "");

    // Find the output file
    const renderedFile = this.findOutput(workDir, sceneName, outputFormat);
    if (!renderedFile) {
      this.cleanup(workDir);
      return toolResult({
        success: false,
        error: `Render succeeded but output file not found. Manim output:\n${procStdout}`,
      });
    }

    // Move to desired output path
    let finalPath: string;
    if (outputPath) {
      finalPath = outputPath;
    } else {
      const ext = path.extname(renderedFile);
      finalPath = `manim_${sceneName}${ext}`;
    }

    fs.mkdirSync(path.dirname(path.resolve(finalPath)), { recursive: true });
    fs.copyFileSync(renderedFile, finalPath);

    // Get video info
    const videoInfo = await this.probeOutput(finalPath);

    // Cleanup temp directory
    this.cleanup(workDir);

    return toolResult({
      success: true,
      data: {
        scene_name: sceneName,
        quality,
        format: outputFormat,
        output: finalPath,
        resolution: preset.resolution,
        fps: preset.fps,
        ...videoInfo,
      },
      artifacts: [finalPath],
    });
  }

  /** Extract Scene subclass name from code. */
  private detectSceneName(code: string): string | null {
    // Match class definitions that inherit from Scene or its variants
    const pattern =
      /class\s+(\w+)\s*\(\s*(?:Scene|ThreeDScene|MovingCameraScene|ZoomedScene)\s*\)/g;
    const matches: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(code)) !== null) {
      matches.push(m[1]!);
    }
    if (matches.length === 1) {
      return matches[0]!;
    }
    if (matches.length > 1) {
      // Return the last one (convention: main scene is last)
      return matches[matches.length - 1]!;
    }
    return null;
  }

  /** Find Manim's output file in the media directory. */
  private findOutput(
    workDir: string,
    sceneName: string,
    fmt: string
  ): string | null {
    const mediaDir = path.join(workDir, "media");
    if (!fs.existsSync(mediaDir)) {
      return null;
    }

    // Manim outputs to media/videos/<scene_file>/<quality>/<SceneName>.<ext>
    // or media/images/<scene_file>/<SceneName>.<ext> for -s flag
    const extMap: Record<string, string> = {
      mp4: ".mp4",
      gif: ".gif",
      webm: ".webm",
      png: ".png",
    };
    const targetExt = extMap[fmt] ?? ".mp4";

    // Search recursively for the output file matching <sceneName><ext>
    const exact = this.rglobFirst(
      mediaDir,
      (name) => name === `${sceneName}${targetExt}`
    );
    if (exact) {
      return exact;
    }

    // Fallback: any file with the right extension
    return this.rglobFirst(mediaDir, (name) => name.endsWith(targetExt));
  }

  /** Recursively walk a directory, returning the first file whose basename matches. */
  private rglobFirst(
    dir: string,
    match: (basename: string) => boolean
  ): string | null {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    // Files first (mirrors rglob semantics closely enough for "first match").
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && match(entry.name)) {
        return full;
      }
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const found = this.rglobFirst(path.join(dir, entry.name), match);
        if (found) {
          return found;
        }
      }
    }
    return null;
  }

  /** Get basic info about the rendered file. */
  private async probeOutput(
    filePath: string
  ): Promise<Record<string, unknown>> {
    const info: Record<string, unknown> = {
      file_size_bytes: fs.statSync(filePath).size,
    };

    if (!commandExists("ffprobe")) {
      return info;
    }

    try {
      const proc = await this.runCommand(
        [
          "ffprobe",
          "-v",
          "quiet",
          "-print_format",
          "json",
          "-show_format",
          "-show_streams",
          filePath,
        ],
        { timeout: 10_000 }
      );
      const probe = JSON.parse(String(proc.stdout ?? ""));
      const fmt = probe.format ?? {};
      info["duration_seconds"] = parseFloat(fmt.duration ?? 0);
      info["file_size_mb"] =
        Math.round((fs.statSync(filePath).size / (1024 * 1024)) * 100) / 100;
      for (const stream of probe.streams ?? []) {
        if (stream.codec_type === "video") {
          info["video_width"] = parseInt(String(stream.width ?? 0), 10);
          info["video_height"] = parseInt(String(stream.height ?? 0), 10);
          info["video_codec"] = stream.codec_name ?? "";
          break;
        }
      }
    } catch {
      // ignore (matches Python's bare except)
    }

    return info;
  }

  /** Remove temp working directory. */
  private cleanup(workDir: string): void {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
