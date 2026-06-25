/**
 * Eye enhancement tool — provider=mediapipe (UNAVAILABLE in the TypeScript port).
 *
 * TypeScript port of tools/enhancement/eye_enhance.py. The Python tool targets
 * the eye region of talking-head footage (under-eye dark-circle brightening,
 * eye/iris brightening, eye sharpening) using MediaPipe Face Mesh (468
 * landmarks) + OpenCV, processing video frame-by-frame, with an OpenCV Haar
 * cascade fallback and finally a crude FFmpeg global-brightness fallback.
 *
 * ## DEVIATION (documented)
 *
 * MediaPipe has no clean Node port, and the OpenCV Haar-cascade fallback
 * likewise depends on cv2 (also unavailable in Node). Both real eye-enhancement
 * code paths require per-frame facial-landmark / eye-region detection that
 * cannot be reproduced faithfully with @napi-rs/canvas or sharp. The Python
 * FFmpeg "fallback" is NOT eye-specific (it just lifts global brightness/
 * contrast for the whole frame) — porting only that path would silently produce
 * a different, non-eye-targeted result while claiming to be eye_enhance, which
 * violates 1:1 behavioral parity and the no-silent-degradation rule.
 *
 * Therefore, per the port directive, this tool:
 *  - Keeps the full contract (name/capability/provider="mediapipe"/tier/schema/
 *    resource_profile/idempotency/verification, the landmark index constants,
 *    and estimateRuntime) faithful to the Python source.
 *  - Reports UNAVAILABLE via get_status() (matches Python: Python returns
 *    AVAILABLE only when mediapipe AND opencv import, DEGRADED with opencv-only,
 *    UNAVAILABLE otherwise — and in the Node runtime neither dependency exists,
 *    so the status is always UNAVAILABLE).
 *  - Returns a clear structured error from execute() instead of running a
 *    misleading non-eye-specific FFmpeg fallback.
 */
import {
  BaseTool,
  Determinism,
  ExecutionMode,
  ResourceProfile,
  ToolResult,
  ToolStability,
  ToolStatus,
  ToolTier,
  toolResult,
} from "../base_tool.js";

// MediaPipe Face Mesh landmark indices for eye regions (kept for contract
// fidelity / documentation; not used at runtime in the TS port).
// Lower eyelid landmarks (used to define the under-eye region):
export const LEFT_LOWER_EYELID = [33, 7, 163, 144, 145, 153, 154, 155, 133];
export const RIGHT_LOWER_EYELID = [263, 249, 390, 373, 374, 380, 381, 382, 362];

// Full eye contour (used for iris/eye brightening):
export const LEFT_EYE = [
  33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246,
];
export const RIGHT_EYE = [
  263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388,
  466,
];

// Iris landmarks (available when refine_landmarks=True, indices 468-477):
export const LEFT_IRIS = [468, 469, 470, 471, 472];
export const RIGHT_IRIS = [473, 474, 475, 476, 477];

export class EyeEnhance extends BaseTool {
  override name = "eye_enhance";
  override version = "0.1.0";
  override tier = ToolTier.ENHANCE;
  override capability = "enhancement";
  override provider = "mediapipe";
  override stability = ToolStability.EXPERIMENTAL;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;

  override dependencies = ["cmd:ffmpeg"];
  override install_instructions =
    "For best results install MediaPipe and OpenCV:\n" +
    "pip install mediapipe opencv-python numpy\n\n" +
    "Without MediaPipe, falls back to FFmpeg eye-region filter (less precise).";
  override agent_skills = ["ffmpeg"];

  override capabilities = [
    "under_eye_brightening",
    "dark_circle_removal",
    "eye_sharpening",
    "eye_brightening",
  ];

  override input_schema = {
    type: "object",
    required: ["input_path"],
    properties: {
      input_path: { type: "string" },
      output_path: { type: "string" },
      operations: {
        type: "array",
        items: {
          type: "string",
          enum: ["dark_circles", "brighten_eyes", "sharpen_eyes"],
        },
        default: ["dark_circles", "brighten_eyes"],
        description: "Which enhancements to apply",
      },
      dark_circle_intensity: {
        type: "number",
        default: 0.4,
        minimum: 0.0,
        maximum: 1.0,
        description: "Strength of dark circle removal (0=none, 1=max)",
      },
      eye_brighten_intensity: {
        type: "number",
        default: 0.3,
        minimum: 0.0,
        maximum: 1.0,
        description: "Strength of eye brightening (0=none, 1=max)",
      },
      sharpen_intensity: {
        type: "number",
        default: 0.3,
        minimum: 0.0,
        maximum: 1.0,
        description: "Strength of eye sharpening (0=none, 1=max)",
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
  override idempotency_key_fields = [
    "input_path",
    "operations",
    "dark_circle_intensity",
    "eye_brighten_intensity",
    "sharpen_intensity",
  ];
  override side_effects = ["writes enhanced video to output_path"];
  override user_visible_verification = [
    "Compare eyes in before/after — enhancement should be subtle and natural",
    "Check for artifacts around eye region (halos, color shifts)",
    "Verify enhancement doesn't make eyes look unnatural",
  ];

  /**
   * Always UNAVAILABLE in the TS port: neither mediapipe nor OpenCV is
   * available on Node, so neither the Face Mesh path nor the Haar-cascade
   * (DEGRADED) path can run. Mirrors the Python get_status() outcome for an
   * environment where both libraries are absent.
   */
  override getStatus(): ToolStatus {
    return ToolStatus.UNAVAILABLE;
  }

  override async execute(_inputs: Record<string, unknown>): Promise<ToolResult> {
    return toolResult({
      success: false,
      error:
        "eye_enhance requires mediapipe facial landmarks (or an OpenCV Haar " +
        "cascade fallback); not available in the TypeScript port. Use the " +
        "Python implementation for precise eye-region enhancement.",
    });
  }

  /** Eye enhancement is roughly 0.5x-1x realtime depending on resolution. */
  override estimateRuntime(_inputs: Record<string, unknown>): number {
    return 90.0;
  }
}
