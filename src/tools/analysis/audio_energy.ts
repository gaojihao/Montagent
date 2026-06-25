/**
 * Analyze audio energy profile to find optimal playback offset.
 *
 * TypeScript port of tools/analysis/audio_energy.py. Uses ffmpeg's ebur128
 * loudness meter to measure momentary loudness at 100ms intervals, then
 * identifies where the music "gets interesting" (crosses a configurable energy
 * threshold). Returns a recommended offset in seconds plus the full energy
 * profile.
 *
 * Parity notes vs. Python:
 *  - Python declared dependencies=["binary:ffmpeg"] and overrode get_status()
 *    to check shutil.which("ffmpeg"). The TS port uses dependencies=
 *    ["cmd:ffmpeg"] so the base getStatus() drives availability identically.
 *    (Python also requires ffprobe at runtime; both ship together with ffmpeg.)
 *  - The ffprobe/ffmpeg arg arrays are translated verbatim.
 *  - ebur128 logs momentary loudness to stderr even though `-f null -` exits 0;
 *    we read result.stderr (wrapped in String()) exactly like the Python
 *    result.stderr parse, using the identical regex.
 *  - Downsampling, key-moment detection, best-window scan, loop recommendation,
 *    and the result_data shape match the Python verbatim (including rounding).
 */
import fs from "node:fs";
import {
  BaseTool,
  Determinism,
  ExecutionMode,
  ResourceProfile,
  RetryPolicy,
  ToolResult,
  ToolRuntime,
  ToolStability,
  ToolTier,
  toolResult,
} from "../base_tool.js";

export class AudioEnergy extends BaseTool {
  override name = "audio_energy";
  override version = "0.1.0";
  override tier = ToolTier.CORE;
  override capability = "analysis";
  override provider = "ffmpeg";
  override stability = ToolStability.PRODUCTION;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;
  override runtime = ToolRuntime.LOCAL;

  override dependencies = ["cmd:ffmpeg"];
  override install_instructions =
    "Install ffmpeg:\n" +
    "  Windows: winget install ffmpeg\n" +
    "  macOS: brew install ffmpeg\n" +
    "  Linux: sudo apt install ffmpeg";

  override capabilities = [
    "find_music_offset",
    "energy_profile",
    "best_window",
    "loop_recommendation",
  ];
  override best_for = [
    "finding where ambient music gets interesting (skip quiet intros)",
    "choosing the best offset for a music track in a video",
    "determining if a music track needs looping for a longer video",
  ];

  override input_schema = {
    type: "object",
    required: ["input_path"],
    properties: {
      input_path: {
        type: "string",
        description: "Path to audio file (mp3, wav, ogg, etc.)",
      },
      video_duration_seconds: {
        type: "number",
        description:
          "Duration of the video this music will accompany. " +
          "Used to recommend looping and find the best offset window.",
      },
      energy_threshold_lufs: {
        type: "number",
        description:
          "Momentary loudness threshold in LUFS to consider " +
          "music 'active' (default: -40). Higher = stricter. " +
          "Typical: -50 for very quiet, -30 for energetic.",
        default: -40,
      },
    },
  };

  override resource_profile: ResourceProfile = {
    cpu_cores: 1,
    ram_mb: 128,
    vram_mb: 0,
    disk_mb: 0,
    network_required: false,
  };
  override retry_policy: RetryPolicy = {
    max_retries: 0,
    backoff_seconds: 1.0,
    retryable_errors: [],
  };
  override idempotency_key_fields = ["input_path"];
  override side_effects = [];

  override estimateCost(_inputs: Record<string, unknown>): number {
    return 0.0;
  }

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const inputPath = inputs.input_path as string;
    if (!fs.existsSync(inputPath)) {
      return toolResult({ success: false, error: `File not found: ${inputPath}` });
    }

    const thresholdLufs = (inputs.energy_threshold_lufs as number) ?? -40;
    const videoDuration = inputs.video_duration_seconds as number | undefined;

    const start = Date.now();

    // ------------------------------------------------------------------
    // Step 1: Get audio duration (ffprobe)
    // ------------------------------------------------------------------
    let audioDuration: number;
    try {
      const probeResult = await this.runCommand(
        [
          "ffprobe",
          "-v",
          "quiet",
          "-print_format",
          "json",
          "-show_format",
          inputPath,
        ],
        { timeout: 10000 }
      );
      const probeData = JSON.parse(String(probeResult.stdout ?? "")) as {
        format: { duration: string };
      };
      audioDuration = parseFloat(probeData.format.duration);
    } catch (e) {
      return toolResult({
        success: false,
        error: `Failed to probe duration: ${(e as Error).message ?? e}`,
      });
    }

    // ------------------------------------------------------------------
    // Step 2: Run ebur128 loudness analysis
    // ------------------------------------------------------------------
    // ebur128 outputs momentary loudness (M:) every 100ms — very precise.
    let stderr: string;
    try {
      const result = await this.runCommand(
        ["ffmpeg", "-i", inputPath, "-af", "ebur128", "-f", "null", "-"],
        { timeout: 120000 }
      );
      stderr = String(result.stderr ?? "");
    } catch (e) {
      const err = e as { timedOut?: boolean; stderr?: string };
      if (err.timedOut) {
        return toolResult({
          success: false,
          error: "ebur128 analysis timed out (120s)",
        });
      }
      // ffmpeg may exit non-zero but still emit the loudness log to stderr.
      stderr = err.stderr ?? "";
    }

    // ------------------------------------------------------------------
    // Step 3: Parse momentary loudness (M:) values
    // ------------------------------------------------------------------
    // Pattern: t: 0.0999773  TARGET:-23 LUFS    M:-120.7 S:-120.7 ...
    const pattern = /t:\s*([\d.]+)\s+.*?M:\s*(-?[\d.]+)/;
    const rawPoints: Array<[number, number]> = [];

    for (const line of stderr.split("\n")) {
      const match = pattern.exec(line);
      if (match) {
        const t = parseFloat(match[1]!);
        const mLufs = parseFloat(match[2]!);
        rawPoints.push([t, mLufs]);
      }
    }

    if (rawPoints.length === 0) {
      return toolResult({
        success: false,
        error: "Failed to parse ebur128 output — no loudness data found",
      });
    }

    // ------------------------------------------------------------------
    // Step 4: Downsample to 1-second intervals (average per second)
    // ------------------------------------------------------------------
    const maxSec = Math.trunc(rawPoints[rawPoints.length - 1]![0]) + 1;
    const energyProfile: Array<Record<string, unknown>> = [];

    for (let sec = 0; sec < maxSec; sec++) {
      // Collect all 100ms points within this second
      const pointsInSec: number[] = [];
      for (const [t, m] of rawPoints) {
        if (sec <= t && t < sec + 1 && m > -120) {
          // -120 = silence marker
          pointsInSec.push(m);
        }
      }

      let avgLufs: number;
      if (pointsInSec.length > 0) {
        avgLufs = pointsInSec.reduce((a, b) => a + b, 0) / pointsInSec.length;
      } else {
        avgLufs = -120.0;
      }

      energyProfile.push({
        time_seconds: sec,
        loudness_lufs: round(avgLufs, 1),
        active: avgLufs > thresholdLufs,
      });
    }

    // ------------------------------------------------------------------
    // Step 5: Find key moments
    // ------------------------------------------------------------------
    // First active second (music becomes meaningful)
    let firstActiveSec = 0.0;
    for (const seg of energyProfile) {
      if (seg.active) {
        firstActiveSec = Number(seg.time_seconds);
        break;
      }
    }

    // Peak loudness second
    const activeSegments = energyProfile.filter(
      (s) => Number(s.loudness_lufs) > -120
    );
    let peakSec: number;
    let peakLufs: number;
    if (activeSegments.length > 0) {
      let peakSeg = activeSegments[0]!;
      for (const s of activeSegments) {
        if (Number(s.loudness_lufs) > Number(peakSeg.loudness_lufs)) {
          peakSeg = s;
        }
      }
      peakSec = Number(peakSeg.time_seconds);
      peakLufs = Number(peakSeg.loudness_lufs);
    } else {
      peakSec = 0.0;
      peakLufs = -120.0;
    }

    // ------------------------------------------------------------------
    // Step 6: Find best window for video duration
    // ------------------------------------------------------------------
    let recommendedOffset = firstActiveSec;
    let offsetReason =
      `First active music at ${firstActiveSec}s ` +
      `(threshold: ${thresholdLufs} LUFS)`;

    if (videoDuration && videoDuration < audioDuration) {
      const windowSize = Math.trunc(videoDuration);
      const loudnessValues = energyProfile.map((s) =>
        Number(s.loudness_lufs) > -120 ? Number(s.loudness_lufs) : -60
      );

      if (loudnessValues.length >= windowSize) {
        let bestAvg = -999.0;
        let bestStart = 0;

        for (let i = 0; i < loudnessValues.length - windowSize + 1; i++) {
          const window = loudnessValues.slice(i, i + windowSize);
          const avg = window.reduce((a, b) => a + b, 0) / window.length;
          if (avg > bestAvg) {
            bestAvg = avg;
            bestStart = i;
          }
        }

        recommendedOffset = bestStart;
        offsetReason =
          `Best ${windowSize}s window starts at ${bestStart}s ` +
          `(avg loudness: ${round(bestAvg, 1)} LUFS)`;
      }
    }

    // ------------------------------------------------------------------
    // Step 7: Loop recommendation
    // ------------------------------------------------------------------
    let needsLoop = false;
    let loopInfo: Record<string, unknown> | null = null;
    if (videoDuration) {
      const availableFromOffset = audioDuration - recommendedOffset;
      if (availableFromOffset < videoDuration) {
        needsLoop = true;
        loopInfo = {
          music_available_from_offset: round(availableFromOffset, 1),
          video_duration: round(videoDuration, 1),
          shortfall_seconds: round(videoDuration - availableFromOffset, 1),
          recommendation:
            `Music from offset ${recommendedOffset}s provides only ` +
            `${round(availableFromOffset, 1)}s but video is ` +
            `${round(videoDuration, 1)}s. Set loop=true and ` +
            `offsetSeconds=${recommendedOffset} in audio config.`,
        };
      }
    }

    // ------------------------------------------------------------------
    // Result
    // ------------------------------------------------------------------
    const resultData = {
      file: inputPath,
      audio_duration_seconds: round(audioDuration, 1),
      analysis: {
        threshold_lufs: thresholdLufs,
        total_seconds: energyProfile.length,
        active_seconds: energyProfile.filter((s) => s.active).length,
        quiet_intro_seconds: firstActiveSec,
        peak_loudness_at_seconds: peakSec,
        peak_loudness_lufs: peakLufs,
      },
      recommended_offset_seconds: recommendedOffset,
      offset_reason: offsetReason,
      needs_loop: needsLoop,
      loop_info: loopInfo,
      energy_profile: energyProfile,
    };

    return toolResult({
      success: true,
      data: resultData,
      duration_seconds: round((Date.now() - start) / 1000, 2),
    });
  }
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
