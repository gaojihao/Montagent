/**
 * Shared helpers for provider-specific video generation tools (TS port of
 * tools/video/_shared.py).
 *
 * The Python file mixed local GPU/diffusers helpers with cloud-API/Modal
 * helpers. Per the "no GPU/PyTorch" exemption, ALL diffusers/torch code is
 * dropped (local_generation_*, load_diffusers_pipeline, generate_local_video,
 * WAN/HUNYUAN/LTX_LOCAL/COGVIDEO variants). The cloud/API/Modal helpers below —
 * which are independent of torch — are ported verbatim (requests -> fetch,
 * subprocess(ffprobe) -> execa).
 */
import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { type ToolResult, toolResult } from "../base_tool.js";

export const HEYGEN_PROVIDERS: Record<string, { name: string; quality: string; speed: string }> = {
  veo_3_1: { name: "Google VEO 3.1", quality: "highest", speed: "slow" },
  veo_3_1_fast: { name: "Google VEO 3.1 Fast", quality: "high", speed: "medium" },
  veo3: { name: "Google VEO 3", quality: "high", speed: "slow" },
  veo3_fast: { name: "Google VEO 3 Fast", quality: "high", speed: "medium" },
  veo2: { name: "Google VEO 2", quality: "medium", speed: "medium" },
  kling_pro: { name: "Kling Pro", quality: "high", speed: "medium" },
  kling_v2: { name: "Kling v2", quality: "medium", speed: "fast" },
  sora_v2: { name: "Sora v2", quality: "high", speed: "slow" },
  sora_v2_pro: { name: "Sora v2 Pro", quality: "highest", speed: "slow" },
  runway_gen4: { name: "Runway Gen-4", quality: "high", speed: "medium" },
  seedance_lite: { name: "Seedance Lite (1.x)", quality: "medium", speed: "fast" },
  seedance_pro: { name: "Seedance Pro (1.x)", quality: "high", speed: "medium" },
  ltx_distilled: { name: "LTX Distilled", quality: "low", speed: "fastest" },
};

export const LTX2_FRAME_COUNTS: Record<string, number> = {
  "1s": 25,
  "2s": 49,
  "3s": 73,
  "4s": 97,
  "5s": 121,
  "6.7s": 161,
  "8s": 193,
};

export function estimateQualityCost(quality: string): number {
  if (quality === "highest") return 0.5;
  if (quality === "high") return 0.35;
  if (quality === "low") return 0.15;
  return 0.2;
}

export function estimateSpeedRuntime(speed: string): number {
  return ({ fastest: 30.0, fast: 60.0, medium: 120.0, slow: 300.0 } as Record<string, number>)[speed] ?? 120.0;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Probe an output file with ffprobe (if available). Async port of probe_output. */
export async function probeOutput(filePath: string): Promise<Record<string, unknown>> {
  const info: Record<string, unknown> = {};
  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return info;
  }
  info.file_size_bytes = size;
  try {
    const { stdout, exitCode } = await execa(
      "ffprobe",
      ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath],
      { timeout: 10000, reject: false }
    );
    if (exitCode === 0) {
      const probe = JSON.parse(stdout) as {
        format?: { duration?: string };
        streams?: Array<Record<string, unknown>>;
      };
      info.duration_seconds = parseFloat(probe.format?.duration ?? "0");
      info.file_size_mb = Math.round((size / (1024 * 1024)) * 100) / 100;
      for (const stream of probe.streams ?? []) {
        if (stream.codec_type === "video") {
          info.video_width = Number(stream.width ?? 0);
          info.video_height = Number(stream.height ?? 0);
          info.video_codec = String(stream.codec_name ?? "");
          break;
        }
      }
    }
  } catch {
    /* ffprobe missing or failed — return size-only info */
  }
  return info;
}

/** Poll a HeyGen workflow execution until it completes; returns the video URL. */
export async function pollHeygen(executionId: string, apiKey: string, timeout = 600): Promise<string> {
  const url = `https://api.heygen.com/v1/workflows/executions/${executionId}`;
  const deadline = Date.now() + timeout * 1000;
  let interval = 5.0;

  while (Date.now() < deadline) {
    const response = await fetch(url, { headers: { "X-Api-Key": apiKey } });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const data = ((await response.json()) as { data?: Record<string, any> }).data ?? {};
    const status = data.status ?? "";

    if (status === "completed") {
      const videoUrl = data.output?.video?.video_url ?? data.output?.video_url;
      if (videoUrl) return videoUrl;
      throw new Error(`Completed but no video_url in output: ${JSON.stringify(data)}`);
    }
    if (status === "failed" || status === "error") {
      throw new Error(`HeyGen generation failed: ${data.error ?? "Unknown"}`);
    }
    await sleep(Math.min(interval, Math.max(0, deadline - Date.now())) * 1000);
    interval = Math.min(interval * 1.2, 30.0);
  }
  throw new Error(`HeyGen execution ${executionId} timed out after ${timeout}s`);
}

/** Upload a local image to fal.ai storage and return a public URL. */
export async function uploadImageFal(imagePath: string): Promise<string> {
  const apiKey = process.env.FAL_KEY ?? process.env.FAL_AI_API_KEY;
  if (!apiKey) throw new Error("FAL_KEY or FAL_AI_API_KEY required for image upload");
  if (!fs.existsSync(imagePath)) throw new Error(`Image not found: ${imagePath}`);

  const suffix = path.extname(imagePath).toLowerCase().replace(/^\./, "");
  const contentType =
    ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" } as Record<string, string>)[
      suffix
    ] ?? "image/png";

  const initResp = await fetch("https://rest.alpha.fal.ai/storage/upload/initiate", {
    method: "POST",
    headers: { Authorization: `Key ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content_type: contentType, file_name: path.basename(imagePath) }),
  });
  if (!initResp.ok) throw new Error(`fal initiate HTTP ${initResp.status}`);
  const data = (await initResp.json()) as { upload_url: string; file_url: string };

  const putResp = await fetch(data.upload_url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: fs.readFileSync(imagePath),
  });
  if (!putResp.ok) throw new Error(`fal upload HTTP ${putResp.status}`);
  return data.file_url;
}

/** Upload a local image to HeyGen (v2 presigned), falling back to fal.ai storage. */
export async function uploadImageHeygen(imagePath: string, apiKey: string): Promise<string> {
  if (!fs.existsSync(imagePath)) throw new Error(`Image not found: ${imagePath}`);
  try {
    const resp = await fetch("https://api.heygen.com/v2/assets/upload", {
      method: "POST",
      headers: { "X-Api-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ content_type: "image/png", file_name: path.basename(imagePath) }),
    });
    if (resp.status === 200) {
      const data = ((await resp.json()) as { data?: Record<string, any> }).data ?? {};
      const uploadUrl = data.upload_url;
      const fileUrl = data.url ?? data.file_url;
      if (uploadUrl && fileUrl) {
        const putResp = await fetch(uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": "image/png" },
          body: fs.readFileSync(imagePath),
        });
        if (putResp.ok) return fileUrl;
      }
    }
  } catch {
    /* fall through to fal.ai */
  }
  return uploadImageFal(imagePath);
}

/** Full HeyGen video generation (text/image -> video). Port of generate_heygen_video. */
export async function generateHeygenVideo(inputs: Record<string, any>): Promise<ToolResult> {
  const apiKey = process.env.HEYGEN_API_KEY;
  if (!apiKey) return toolResult({ success: false, error: "HEYGEN_API_KEY not set." });

  const provider = inputs.provider_variant ?? "veo_3_1";
  if (!(provider in HEYGEN_PROVIDERS)) {
    return toolResult({
      success: false,
      error: `Unknown provider_variant: ${provider}. Available: ${Object.keys(HEYGEN_PROVIDERS).sort().join(", ")}`,
    });
  }

  const prompt = inputs.prompt as string;
  const aspectRatio = inputs.aspect_ratio ?? "16:9";
  const operation = inputs.operation ?? "text_to_video";
  const workflowInput: Record<string, unknown> = { prompt, provider, aspect_ratio: aspectRatio };

  if (operation === "image_to_video") {
    let refUrl = inputs.reference_image_url as string | undefined;
    const refPath = inputs.reference_image_path as string | undefined;
    if (refPath && !refUrl) refUrl = await uploadImageHeygen(refPath, apiKey);
    if (!refUrl)
      return toolResult({
        success: false,
        error: "image_to_video requires reference_image_url or reference_image_path",
      });
    workflowInput.reference_image_url = refUrl;
  }

  const response = await fetch("https://api.heygen.com/v1/workflows/executions", {
    method: "POST",
    headers: { "X-Api-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ workflow_type: "GenerateVideoNode", input: workflowInput }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const payload = (await response.json()) as { data?: { execution_id?: string } };
  const executionId = payload.data?.execution_id;
  if (!executionId) return toolResult({ success: false, error: `No execution_id in response: ${JSON.stringify(payload)}` });

  const videoUrl = await pollHeygen(executionId, apiKey, 600);
  const outputPath = path.resolve((inputs.output_path as string) ?? `heygen_video_${executionId}.mp4`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const download = await fetch(videoUrl);
  if (!download.ok) throw new Error(`download HTTP ${download.status}`);
  fs.writeFileSync(outputPath, Buffer.from(await download.arrayBuffer()));

  const meta = HEYGEN_PROVIDERS[provider]!;
  return toolResult({
    success: true,
    data: {
      provider: "heygen",
      provider_variant: provider,
      provider_name: meta.name,
      mode: "api",
      prompt,
      aspect_ratio: aspectRatio,
      operation,
      execution_id: executionId,
      output: outputPath,
      format: "mp4",
    },
    artifacts: [outputPath],
    model: provider,
  });
}

/** LTX-2 via a Modal endpoint (cloud, NOT local GPU). Port of generate_ltx_modal_video. */
export async function generateLtxModalVideo(inputs: Record<string, any>): Promise<ToolResult> {
  const endpointUrl = process.env.MODAL_LTX2_ENDPOINT_URL;
  if (!endpointUrl) return toolResult({ success: false, error: "MODAL_LTX2_ENDPOINT_URL not set." });

  const prompt = inputs.prompt as string;
  const operation = inputs.operation ?? "text_to_video";
  const aspect = inputs.aspect_ratio ?? "16:9";
  let width = inputs.width as number | undefined;
  let height = inputs.height as number | undefined;
  if (width === undefined || height === undefined) {
    if (aspect === "16:9") [width, height] = [1024, 576];
    else if (aspect === "9:16") [width, height] = [576, 1024];
    else [width, height] = [512, 512];
  }

  let numFrames = (inputs.num_frames as number) ?? LTX2_FRAME_COUNTS[(inputs.duration_hint as string) ?? "5s"] ?? 121;
  if ((numFrames - 1) % 8 !== 0) numFrames = Math.floor((numFrames - 1) / 8) * 8 + 1;

  const payload: Record<string, unknown> = {
    prompt,
    width,
    height,
    num_frames: numFrames,
    fps: 24,
    steps: inputs.num_inference_steps ?? 30,
    negative_prompt: "worst quality, low quality, blurry, distorted, watermark, text, logo",
  };
  if (inputs.seed != null) payload.seed = inputs.seed;

  if (operation === "image_to_video") {
    const refPath = inputs.reference_image_path as string | undefined;
    const refUrl = inputs.reference_image_url as string | undefined;
    if (refPath) payload.input_image = fs.readFileSync(refPath).toString("base64");
    else if (refUrl) payload.input_image_url = refUrl;
    else
      return toolResult({
        success: false,
        error: "image_to_video requires reference_image_url or reference_image_path",
      });
  }

  const response = await fetch(endpointUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const outputPath = path.resolve((inputs.output_path as string) ?? "ltx_video_modal.mp4");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("video") || contentType.includes("octet-stream")) {
    fs.writeFileSync(outputPath, Buffer.from(await response.arrayBuffer()));
  } else {
    const responsePayload = (await response.json()) as { video_url?: string; url?: string };
    const videoUrl = responsePayload.video_url ?? responsePayload.url;
    if (!videoUrl) return toolResult({ success: false, error: `No video data in response: ${JSON.stringify(responsePayload)}` });
    const download = await fetch(videoUrl);
    if (!download.ok) throw new Error(`download HTTP ${download.status}`);
    fs.writeFileSync(outputPath, Buffer.from(await download.arrayBuffer()));
  }

  return toolResult({
    success: true,
    data: {
      provider: "ltx-modal",
      provider_name: "LTX-2 (Modal)",
      mode: "modal",
      prompt,
      width,
      height,
      num_frames: numFrames,
      fps: 24,
      duration_seconds: Math.round((numFrames / 24) * 100) / 100,
      operation,
      output: outputPath,
      format: "mp4",
    },
    artifacts: [outputPath],
    seed: inputs.seed ?? null,
    model: "ltx-2",
  });
}
