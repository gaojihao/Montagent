/**
 * Scene detection tool wrapping PySceneDetect (with an FFmpeg fallback).
 *
 * TypeScript port of tools/analysis/scene_detect.py. Detects scene boundaries
 * and shot changes in video.
 *
 * Parity notes vs. Python:
 *  - The Python tool prefers PySceneDetect when importable and otherwise falls
 *    back to an FFmpeg/ffprobe scene-change filter. PySceneDetect is a Python
 *    CV library (scenedetect[opencv]) with no clean Node port, so the TS port
 *    only implements the FFmpeg fallback — exactly the path the Python code
 *    takes when scenedetect is NOT installed. The reported method is therefore
 *    always "ffmpeg" (matching Python's behavior in a scenedetect-free env),
 *    and the contract keeps provider="ffmpeg" + dependencies=["cmd:ffmpeg"]
 *    just like the Python source.
 *  - The ffprobe/ffmpeg arg arrays (including the lavfi movie+select graph and
 *    the Windows path escaping) are translated verbatim, as is the change-point
 *    accumulation, min-scene-length gating, and the scene dict shape.
 */
import fs from "node:fs";
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

interface Scene {
  index: number;
  start_seconds: number;
  end_seconds: number;
  duration_seconds: number;
}

export class SceneDetect extends BaseTool {
  override name = "scene_detect";
  override version = "0.1.0";
  override tier = ToolTier.CORE;
  override capability = "analysis";
  override provider = "ffmpeg";
  override stability = ToolStability.EXPERIMENTAL;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;

  override dependencies = ["cmd:ffmpeg"];
  override install_instructions =
    "FFmpeg is required. For better detection install PySceneDetect:\n" +
    "pip install scenedetect[opencv]";
  override agent_skills = ["ffmpeg"];

  override capabilities = [
    "detect_scenes",
    "detect_content_changes",
    "detect_threshold",
  ];

  override input_schema = {
    type: "object",
    required: ["input_path"],
    properties: {
      input_path: { type: "string" },
      method: {
        type: "string",
        enum: ["content", "threshold", "adaptive"],
        default: "content",
      },
      threshold: {
        type: "number",
        description: "Detection threshold (method-dependent)",
      },
      min_scene_length_seconds: {
        type: "number",
        minimum: 0.1,
        default: 1.0,
      },
      output_path: { type: "string", description: "Path for scene list JSON" },
    },
  };

  override resource_profile: ResourceProfile = {
    cpu_cores: 2,
    ram_mb: 1024,
    vram_mb: 0,
    disk_mb: 100,
    network_required: false,
  };
  override idempotency_key_fields = ["input_path", "method", "threshold"];
  override side_effects = ["writes scene list JSON to output_path"];
  override user_visible_verification = [
    "Spot-check detected scene boundaries against the video",
  ];

  /**
   * PySceneDetect is a Python-only CV dependency; it is never available in the
   * Node port. Returns false so execute() always uses the FFmpeg path — the
   * faithful behavior of the Python code in a scenedetect-free environment.
   */
  private _hasPyscenedetect(): boolean {
    return false;
  }

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const inputPath = inputs.input_path as string;
    if (!fs.existsSync(inputPath)) {
      return toolResult({ success: false, error: `Input not found: ${inputPath}` });
    }

    const start = Date.now();

    // PySceneDetect is unavailable in Node; always use the FFmpeg fallback.
    const scenes = await this._detectFfmpeg(inputs);

    const elapsed = (Date.now() - start) / 1000;

    // Write scene list
    const outputPath =
      (inputs.output_path as string) ?? withSuffix(inputPath, ".scenes.json");
    const outDir = dirname(outputPath);
    if (outDir) fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify({ scenes }, null, 2), {
      encoding: "utf-8",
    });

    return toolResult({
      success: true,
      data: {
        scene_count: scenes.length,
        scenes,
        method: this._hasPyscenedetect() ? "pyscenedetect" : "ffmpeg",
        output: outputPath,
      },
      artifacts: [outputPath],
      duration_seconds: round(elapsed, 2),
    });
  }

  /** Fallback: use FFmpeg scene change filter. */
  private async _detectFfmpeg(
    inputs: Record<string, unknown>
  ): Promise<Scene[]> {
    const inputPath = inputs.input_path as string;
    const threshold = (inputs.threshold as number) ?? 0.3;
    const minSceneLen = (inputs.min_scene_length_seconds as number) ?? 1.0;

    // Verbatim translation of Python's path escaping:
    //   input_path.replace(chr(92), '/').replace(':', chr(92)+':')
    const escaped = inputPath.split("\\").join("/").split(":").join("\\:");
    const cmd = [
      "ffprobe",
      "-v",
      "quiet",
      "-show_entries",
      "frame=pts_time",
      "-of",
      "json",
      "-f",
      "lavfi",
      `movie='${escaped}',select='gt(scene,${threshold})'`,
    ];

    let data: { frames?: Array<Record<string, unknown>> };
    try {
      const result = await this.runCommand(cmd, { timeout: 120000 });
      data = JSON.parse(String(result.stdout ?? ""));
    } catch {
      // If ffprobe lavfi approach fails, try a simpler method
      return this._detectFfmpegSimple(inputPath, threshold, minSceneLen);
    }

    const changePoints: number[] = [0.0];
    for (const frame of data.frames ?? []) {
      const ts = parseFloat(String(frame.pts_time ?? 0));
      if (ts - changePoints[changePoints.length - 1]! >= minSceneLen) {
        changePoints.push(ts);
      }
    }

    // Get total duration
    const durCmd = [
      "ffprobe",
      "-v",
      "quiet",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
      inputPath,
    ];
    const durResult = await this.runCommand(durCmd);
    const totalDur = parseFloat(
      (JSON.parse(String(durResult.stdout ?? "")) as { format: { duration: string } })
        .format.duration
    );
    changePoints.push(totalDur);

    return buildScenes(changePoints);
  }

  /** Simplest fallback: detect scene changes via the showinfo filter on stderr. */
  private async _detectFfmpegSimple(
    inputPath: string,
    threshold: number,
    minSceneLen: number
  ): Promise<Scene[]> {
    const durCmd = [
      "ffprobe",
      "-v",
      "quiet",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
      inputPath,
    ];
    const durResult = await this.runCommand(durCmd);
    const totalDur = parseFloat(
      (JSON.parse(String(durResult.stdout ?? "")) as { format: { duration: string } })
        .format.duration
    );

    // Use select filter to find scene changes via stderr
    const cmd = [
      "ffmpeg",
      "-i",
      inputPath,
      "-vf",
      `select='gt(scene,${threshold})',showinfo`,
      "-f",
      "null",
      "-",
    ];
    let output: string;
    try {
      const result = await this.runCommand(cmd, { timeout: 120000 });
      output = String(result.stderr ?? "");
    } catch (e) {
      const err = e as { stderr?: string };
      output = err.stderr ?? "";
    }

    const changePoints: number[] = [0.0];
    for (const match of output.matchAll(/pts_time:(\d+\.?\d*)/g)) {
      const ts = parseFloat(match[1]!);
      if (ts - changePoints[changePoints.length - 1]! >= minSceneLen) {
        changePoints.push(ts);
      }
    }
    changePoints.push(totalDur);

    return buildScenes(changePoints);
  }
}

function buildScenes(changePoints: number[]): Scene[] {
  const scenes: Scene[] = [];
  for (let i = 0; i < changePoints.length - 1; i++) {
    const start = changePoints[i]!;
    const end = changePoints[i + 1]!;
    scenes.push({
      index: i,
      start_seconds: round(start, 3),
      end_seconds: round(end, 3),
      duration_seconds: round(end - start, 3),
    });
  }
  return scenes;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Python Path.with_suffix: replace the final extension (or append if none). */
function withSuffix(filePath: string, suffix: string): string {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const base = filePath.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return filePath.slice(0, slash + 1) + stem + suffix;
}

function dirname(filePath: string): string {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return slash >= 0 ? filePath.slice(0, slash) : "";
}
