/**
 * Doubao Seedance video generation via a custom OpenAI-compatible gateway.
 *
 * Self-contained, fully env-driven provider tool. It is intentionally
 * decoupled from every other tool: it touches no shared state and is wired in
 * only by being listed in tools/index.ts ALL_TOOLS. Because capability is
 * "video_generation", video_selector and preflight discover it automatically.
 *
 * Configure with three env vars (see install_instructions):
 *   - DOUBAO_SEEDANCE_API_KEY   (required) -> Authorization: Bearer <key>
 *   - DOUBAO_SEEDANCE_BASE_URL  (required) -> gateway root, e.g. https://host or https://host/v1
 *   - DOUBAO_SEEDANCE_MODEL     (optional) -> defaults to "doubao-seedance-1.0-pro"
 *
 * Wire contract (verified against models-proxy.stepfun-inc.com):
 *   submit:  POST {baseUrl}/v1/videos/generations
 *            body { model, prompt:"<prompt> --ratio .. --duration .. --resolution ..", image:"<url>" }
 *                  (image only for image_to_video; generation params ride as Seedance --flags in prompt)
 *            -> { task_id, status, result:{ url, origin_url } }  (this gateway returns the result inline)
 *   query:   GET  {baseUrl}/v1/videos/query?task_id=<task_id>&model=<model>
 *            -> same shape; status "success" when done; video url at result.url
 *            (parsing also tolerates id / video_url / content.video_url / data[].url variants)
 *
 * If your specific gateway differs, the request body is built in buildPromptText()
 * (+ the body assembly in execute), the query URL is built in execute, and
 * responses are parsed in extractTaskId()/extractResult() — adjust there only.
 */
import fs from "node:fs";
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
  ToolTier,
  toolResult,
} from "../base_tool.js";
import { probeOutput } from "./_shared.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const DEFAULT_MODEL = "doubao-seedance-1.0-pro";
// MIME types keyed by lowercase file extension, for base64 data URIs.
const IMAGE_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

export class DoubaoSeedanceVideo extends BaseTool {
  override name = "doubao_seedance_video";
  override version = "0.1.0";
  override tier = ToolTier.GENERATE;
  override capability = "video_generation";
  override provider = "doubao";
  override stability = ToolStability.BETA;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.STOCHASTIC;
  override runtime = ToolRuntime.API;

  // Both must be set for the tool to report AVAILABLE (drives preflight/menu).
  override dependencies = [
    "env:DOUBAO_SEEDANCE_API_KEY",
    "env:DOUBAO_SEEDANCE_BASE_URL",
  ];
  override install_instructions =
    "Set DOUBAO_SEEDANCE_API_KEY and DOUBAO_SEEDANCE_BASE_URL for your video gateway.\n" +
    "  DOUBAO_SEEDANCE_API_KEY  -- gateway key, sent as 'Authorization: Bearer <key>'.\n" +
    "  DOUBAO_SEEDANCE_BASE_URL -- gateway root, e.g. https://your-gateway.com (with or without /v1).\n" +
    "  DOUBAO_SEEDANCE_MODEL    -- optional, defaults to doubao-seedance-1.0-pro.\n" +
    "  Gateway must expose POST /v1/videos/generations and GET /v1/videos/query?id=<task_id>.";
  override agent_skills = ["ai-video-gen", "seedance-2-0"];

  override capabilities = ["text_to_video", "image_to_video"];
  override supports = {
    text_to_video: true,
    image_to_video: true,
    reference_image: true,
    native_audio: false,
    cinematic_quality: true,
    camera_direction: true,
    aspect_ratio: true,
    seed: true,
    custom_endpoint: true,
  };
  override best_for = [
    "doubao-seedance-1.0-pro video generation via a self-hosted / proxy gateway",
    "text-to-video and image-to-video with a configurable baseUrl + apiKey + model",
    "keeping a custom provider fully decoupled from the rest of the toolset",
  ];
  override not_good_for = [
    "offline generation",
    "providers that do not expose /v1/videos/generations + /v1/videos/query",
  ];
  override quality_score = 0.9;

  override input_schema = {
    type: "object",
    required: ["prompt"],
    properties: {
      prompt: { type: "string" },
      operation: {
        type: "string",
        enum: ["text_to_video", "image_to_video"],
        default: "text_to_video",
      },
      image_url: {
        type: "string",
        description: "Start-frame image URL for image_to_video.",
      },
      image_path: {
        type: "string",
        description:
          "Local start-frame path for image_to_video. Encoded as a base64 data URI (no external upload).",
      },
      aspect_ratio: {
        type: "string",
        enum: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16", "adaptive"],
        default: "16:9",
      },
      duration: {
        type: "integer",
        minimum: 3,
        maximum: 12,
        default: 5,
        description: "Clip duration in seconds.",
      },
      resolution: {
        type: "string",
        enum: ["480p", "720p", "1080p"],
        default: "1080p",
      },
      seed: { type: "integer", description: "Optional seed for reproducibility." },
      watermark: { type: "boolean", default: false },
      camera_fixed: {
        type: "boolean",
        description: "Lock the camera (no movement) when supported by the model.",
      },
      model: {
        type: "string",
        description:
          "Override the model id. Defaults to DOUBAO_SEEDANCE_MODEL or doubao-seedance-1.0-pro.",
      },
      base_url: {
        type: "string",
        description: "Override the gateway base URL for this call (defaults to DOUBAO_SEEDANCE_BASE_URL).",
      },
      output_path: { type: "string" },
      poll_interval_seconds: { type: "number", default: 5, minimum: 1 },
      timeout_seconds: { type: "integer", default: 1200, minimum: 30 },
    },
  };

  override output_schema = {
    type: "object",
    properties: {
      output: { type: "string" },
      output_path: { type: "string" },
      task_id: { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      seed: { type: ["integer", "null"] },
    },
  };

  override resource_profile: ResourceProfile = {
    cpu_cores: 1,
    ram_mb: 512,
    vram_mb: 0,
    disk_mb: 500,
    network_required: true,
  };
  override retry_policy: RetryPolicy = {
    max_retries: 2,
    backoff_seconds: 2.0,
    retryable_errors: ["rate_limit", "timeout"],
  };
  override idempotency_key_fields = [
    "prompt",
    "operation",
    "duration",
    "resolution",
    "aspect_ratio",
    "seed",
  ];
  override side_effects = [
    "writes video file to output_path",
    "calls the configured Doubao Seedance gateway",
  ];
  override user_visible_verification = [
    "Watch generated clip for motion coherence and visual quality",
  ];

  override estimateCost(inputs: Record<string, unknown>): number {
    // Rough per-second placeholder for budget governance only — tune the rate
    // to your gateway's real pricing.
    const duration = typeof inputs.duration === "number" ? inputs.duration : 5;
    const rate = 0.06; // USD per second (estimate)
    return Math.round(rate * duration * 100) / 100;
  }

  override estimateRuntime(_inputs: Record<string, unknown>): number {
    return 120.0;
  }

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const apiKey = process.env.DOUBAO_SEEDANCE_API_KEY;
    const baseUrl =
      (inputs.base_url as string) || process.env.DOUBAO_SEEDANCE_BASE_URL;
    if (!apiKey || !baseUrl) {
      return toolResult({
        success: false,
        error:
          "DOUBAO_SEEDANCE_API_KEY and DOUBAO_SEEDANCE_BASE_URL must be set. " +
          this.install_instructions,
      });
    }

    const start = Date.now();
    const model =
      (inputs.model as string) || process.env.DOUBAO_SEEDANCE_MODEL || DEFAULT_MODEL;
    const operation = (inputs.operation as string) ?? "text_to_video";
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };

    let outputPath: string;
    let taskId: string;
    let videoUrl: string;
    let resultSeed: number | null = null;

    try {
      // --- build request body (Ark content-array shape) ---
      let imageRef: string | undefined;
      if (operation === "image_to_video") {
        if (inputs.image_url) {
          imageRef = inputs.image_url as string;
        } else if (inputs.image_path) {
          imageRef = imageToDataUri(inputs.image_path as string);
        } else {
          return toolResult({
            success: false,
            error: "image_to_video requires image_url or image_path.",
          });
        }
      }
      const body: Record<string, unknown> = {
        model,
        prompt: buildPromptText(inputs),
      };
      if (imageRef) body.image = imageRef;

      // Generation budget. This gateway can return the finished result inline on
      // the submit call (blocking the connection for the whole generation), so the
      // submit/query fetch timeouts must cover the full job, not a short ceiling.
      const pollInterval =
        typeof inputs.poll_interval_seconds === "number"
          ? inputs.poll_interval_seconds
          : 5;
      const timeoutSeconds =
        typeof inputs.timeout_seconds === "number" ? inputs.timeout_seconds : 1200;
      const httpTimeoutMs = timeoutSeconds * 1000;

      // --- submit ---
      const submitResp = await fetch(joinUrl(baseUrl, "/v1/videos/generations"), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(httpTimeoutMs),
      });
      const submitData = await jsonOrRaise(submitResp);
      taskId = extractTaskId(submitData);

      // --- resolve result: submit may already be terminal; otherwise poll ---
      const deadline = Date.now() + httpTimeoutMs;
      const queryUrl =
        joinUrl(baseUrl, "/v1/videos/query") +
        `?task_id=${encodeURIComponent(taskId)}&model=${encodeURIComponent(model)}`;

      let resultData: Record<string, unknown> = submitData;
      for (;;) {
        const { status, url, seed } = extractResult(resultData);
        if (seed != null) resultSeed = seed;
        if (isSuccess(status)) {
          if (!url) {
            throw new Error(
              `Task ${taskId} reported success but no video url was found in the response`
            );
          }
          videoUrl = url;
          break;
        }
        if (isFailure(status)) {
          const msg =
            (resultData.error as string) ??
            (resultData.msg as string) ??
            (resultData.message as string) ??
            JSON.stringify(resultData);
          throw new Error(`Task ${taskId} ${status}: ${msg}`);
        }
        // queued/running -> wait and query again
        if (Date.now() >= deadline) {
          throw new Error(
            `Task ${taskId} did not finish within ${timeoutSeconds}s`
          );
        }
        await sleep(pollInterval * 1000);
        const queryResp = await fetch(queryUrl, {
          method: "GET",
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(httpTimeoutMs),
        });
        resultData = await jsonOrRaise(queryResp);
      }

      // --- download ---
      const videoResp = await fetch(videoUrl, {
        signal: AbortSignal.timeout(180000),
      });
      if (!videoResp.ok) {
        const errBody = await videoResp.text().catch(() => "");
        throw new Error(
          `HTTP ${videoResp.status} ${videoResp.statusText}: ${errBody}`
        );
      }
      outputPath = path.resolve(
        (inputs.output_path as string) ?? "doubao_seedance_output.mp4"
      );
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, Buffer.from(await videoResp.arrayBuffer()));
    } catch (e) {
      return toolResult({
        success: false,
        error: `Doubao Seedance video generation failed: ${this.safeError(e)}`,
      });
    }

    const probed = await probeOutput(outputPath);
    return toolResult({
      success: true,
      data: {
        provider: this.provider,
        model,
        prompt: inputs.prompt,
        operation,
        aspect_ratio: (inputs.aspect_ratio as string) ?? "16:9",
        resolution: (inputs.resolution as string) ?? "1080p",
        duration: (inputs.duration as number) ?? 5,
        task_id: taskId,
        seed: resultSeed ?? (inputs.seed as number) ?? null,
        output: outputPath,
        output_path: outputPath,
        format: "mp4",
        ...probed,
      },
      artifacts: [outputPath],
      cost_usd: this.estimateCost(inputs),
      duration_seconds: Math.round((Date.now() - start) / 10) / 100,
      seed: resultSeed ?? (inputs.seed as number) ?? null,
      model,
    });
  }

  /** Never echo the API key in user-visible errors. */
  private safeError(exc: unknown): string {
    const msg = (exc as Error)?.message ?? String(exc);
    const key = process.env.DOUBAO_SEEDANCE_API_KEY ?? "";
    return key ? msg.split(key).join("[redacted]") : msg;
  }
}

// ---------------------------------------------------------------------------
// Wire helpers — adjust ONLY these if your gateway's shape differs.
// ---------------------------------------------------------------------------

/** Join a gateway base URL with a "/v1/..." path, tolerating a trailing /v1. */
function joinUrl(base: string, suffix: string): string {
  const b = base.replace(/\/+$/, "");
  if (b.endsWith("/v1") && suffix.startsWith("/v1/")) {
    return b + suffix.slice(3); // drop the duplicate "/v1"
  }
  return b + suffix;
}

/** Build the prompt text with Volcengine Seedance --flags appended (ratio/duration/etc.). */
function buildPromptText(inputs: Record<string, unknown>): string {
  const flags: string[] = [];
  if (inputs.aspect_ratio) flags.push(`--ratio ${inputs.aspect_ratio}`);
  if (inputs.duration != null) flags.push(`--duration ${inputs.duration}`);
  if (inputs.resolution) flags.push(`--resolution ${inputs.resolution}`);
  if (inputs.seed != null) flags.push(`--seed ${inputs.seed}`);
  if (inputs.watermark != null) flags.push(`--watermark ${Boolean(inputs.watermark)}`);
  if (inputs.camera_fixed != null)
    flags.push(`--camerafixed ${Boolean(inputs.camera_fixed)}`);

  return [String(inputs.prompt ?? ""), ...flags].join(" ").trim();
}

/** Pull the task id from the submit response, tolerating common key variants. */
function extractTaskId(data: Record<string, unknown>): string {
  const nested = (data.data as Record<string, unknown> | undefined) ?? {};
  const id =
    (data.id as string) ??
    (data.task_id as string) ??
    (nested.id as string) ??
    (nested.task_id as string);
  if (!id) {
    throw new Error(
      `Submit succeeded but no task id found in response: ${JSON.stringify(data)}`
    );
  }
  return id;
}

/** Pull status + video url + seed from a query response, tolerating variants. */
function extractResult(data: Record<string, unknown>): {
  status: string;
  url?: string;
  seed?: number | null;
} {
  const nested = (data.data as Record<string, unknown> | undefined) ?? {};
  const content = (data.content as Record<string, unknown> | undefined) ?? {};
  const result = (data.result as Record<string, unknown> | undefined) ?? {};
  const status = String(
    (data.status as string) ?? (nested.status as string) ?? "unknown"
  ).toLowerCase();

  const dataArr = Array.isArray(data.data)
    ? (data.data as Array<Record<string, unknown>>)
    : undefined;
  const url =
    (result.url as string) ??
    (result.origin_url as string) ??
    (content.video_url as string) ??
    (data.video_url as string) ??
    (nested.video_url as string) ??
    (dataArr?.[0]?.url as string) ??
    (data.url as string);

  const seedRaw = (result.seed ?? content.seed ?? data.seed ?? nested.seed) as
    | number
    | undefined;
  return {
    status,
    url,
    seed: typeof seedRaw === "number" ? seedRaw : null,
  };
}

function isSuccess(status: string): boolean {
  return ["succeeded", "success", "completed", "done"].includes(status);
}

function isFailure(status: string): boolean {
  return ["failed", "error", "cancelled", "canceled"].includes(status);
}

/** Read a local image and return a base64 data URI usable as image_url.url. */
function imageToDataUri(imagePath: string): string {
  const resolved = path.resolve(imagePath);
  const ext = path.extname(resolved).toLowerCase();
  const mime = IMAGE_MIME[ext] ?? "image/jpeg";
  const b64 = fs.readFileSync(resolved).toString("base64");
  return `data:${mime};base64,${b64}`;
}

/** Parse JSON or throw a status-bearing error (mirrors requests.raise_for_status). */
async function jsonOrRaise(
  response: Response
): Promise<Record<string, unknown>> {
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${body}`);
  }
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    throw new Error(`Non-JSON response: HTTP ${response.status}`);
  }
}
