/**
 * Face tracking tool using MediaPipe Face Mesh — provider=mediapipe
 * (UNAVAILABLE in the TypeScript port).
 *
 * TypeScript port of tools/analysis/face_tracker.py. The Python tool tracks face
 * bounding boxes, landmarks, and head pose across video frames and writes
 * per-frame face data as JSON — consumed by auto_reframe, face_enhance, and
 * other tools that need to know where the speaker's face is. It uses MediaPipe
 * Face Detection with an OpenCV Haar-cascade fallback, decoding video
 * frame-by-frame with cv2.VideoCapture.
 *
 * ## DEVIATION (documented)
 *
 * Both real code paths require Python-only CV libraries with no clean Node port:
 *  - The primary path needs `mediapipe` (face detection on RGB frames).
 *  - The fallback path needs `cv2` (OpenCV Haar cascade + VideoCapture decoding
 *    and per-frame BGR/gray conversion).
 * Neither mediapipe nor cv2 exists in the Node runtime, and there is no
 * faithful frame-by-frame face-detection substitute available via
 * @napi-rs/canvas / sharp. Porting a degraded stand-in would silently produce
 * different bounding boxes while claiming to be face_tracker, violating 1:1
 * behavioral parity and the no-silent-degradation rule.
 *
 * Therefore, per the port directive, this tool:
 *  - Keeps the full contract faithful to the Python source (name/capability/
 *    provider="mediapipe"/tier/stability/input_schema/output_schema/
 *    resource_profile/idempotency/verification).
 *  - Reports UNAVAILABLE via getStatus(). The Python get_status() returns
 *    AVAILABLE only when BOTH mediapipe and cv2 import, DEGRADED with cv2 only,
 *    and UNAVAILABLE otherwise — in the Node runtime neither exists, so the
 *    status is always UNAVAILABLE, which this override returns directly.
 *  - Returns a clear structured error from execute() instead of running a
 *    misleading degraded fallback.
 *
 * Note on pre-computed input: the Python tool does NOT accept pre-computed face
 * data (its input_schema only takes input_path/output_path/sample_fps/
 * min_detection_confidence and always runs detection), so there is no
 * pre-computed path to honor here.
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

export class FaceTracker extends BaseTool {
  override name = "face_tracker";
  override version = "0.1.0";
  override tier = ToolTier.CORE;
  override capability = "analysis";
  override provider = "mediapipe";
  override stability = ToolStability.EXPERIMENTAL;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;

  override dependencies = ["cmd:ffmpeg"];
  override install_instructions =
    "For best results install MediaPipe:\n" +
    "pip install mediapipe opencv-python\n\n" +
    "Falls back to OpenCV Haar cascade (ships with opencv-python).";
  override agent_skills = ["ffmpeg"];

  override capabilities = [
    "face_detection",
    "face_tracking",
    "face_bounding_box",
    "head_pose_estimation",
  ];

  override input_schema = {
    type: "object",
    required: ["input_path"],
    properties: {
      input_path: { type: "string" },
      output_path: {
        type: "string",
        description: "Path for face tracking JSON output",
      },
      sample_fps: {
        type: "number",
        default: 5,
        description: "Frames per second to sample (lower = faster, less precise)",
      },
      min_detection_confidence: {
        type: "number",
        default: 0.5,
        minimum: 0.0,
        maximum: 1.0,
      },
    },
  };

  override output_schema = {
    type: "object",
    properties: {
      frame_count: { type: "integer" },
      face_detected_count: { type: "integer" },
      video_width: { type: "integer" },
      video_height: { type: "integer" },
      fps: { type: "number" },
      duration_seconds: { type: "number" },
      faces: {
        type: "array",
        items: {
          type: "object",
          properties: {
            frame_index: { type: "integer" },
            timestamp_seconds: { type: "number" },
            bbox: {
              type: "object",
              properties: {
                x: { type: "number" },
                y: { type: "number" },
                width: { type: "number" },
                height: { type: "number" },
              },
            },
          },
        },
      },
    },
  };

  override resource_profile: ResourceProfile = {
    cpu_cores: 2,
    ram_mb: 1024,
    vram_mb: 0,
    disk_mb: 100,
    network_required: false,
  };
  override idempotency_key_fields = [
    "input_path",
    "sample_fps",
    "min_detection_confidence",
  ];
  override side_effects = ["writes face tracking JSON to output_path"];
  override user_visible_verification = [
    "Spot-check bounding boxes against video frames",
  ];

  override fallback_tools = [];

  override getStatus(): ToolStatus {
    // Python: AVAILABLE iff mediapipe AND cv2 import; DEGRADED with cv2 only;
    // UNAVAILABLE otherwise. Neither dependency exists in the Node runtime.
    return ToolStatus.UNAVAILABLE;
  }

  override async execute(_inputs: Record<string, unknown>): Promise<ToolResult> {
    return toolResult({
      success: false,
      error:
        "face_tracker requires mediapipe (with an OpenCV Haar-cascade " +
        "fallback) for frame-by-frame face detection, which is not available " +
        "in the TypeScript port. Run the Python face_tracker tool for face " +
        "tracking, or supply pre-computed face data to downstream tools.",
    });
  }
}
