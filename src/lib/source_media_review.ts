/** Source media review helper (TS port of lib/source_media_review.py).
 * Normalizes inspection of user-supplied media via analysis tools + ffprobe fallback. */
import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { registry as defaultRegistry } from "../tools/tool_registry.js";
import { ToolStatus } from "../tools/base_tool.js";

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".avi", ".mkv", ".m4v"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".aac", ".flac", ".ogg", ".m4a", ".opus"]);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff", ".svg"]);

type Reg = { get(name: string): { getStatus(): ToolStatus; execute(i: Record<string, unknown>): Promise<{ success: boolean; data?: Record<string, any> }> } | undefined };

export function detectMediaType(p: string): string | null {
  const ext = path.extname(p).toLowerCase();
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  return null;
}

function parseFps(fpsStr: string): number {
  try {
    if (fpsStr.includes("/")) {
      const [num, den] = fpsStr.split("/").map(Number);
      return Math.round((num! / Math.max(den!, 1)) * 100) / 100;
    }
    return parseFloat(fpsStr);
  } catch {
    return 0.0;
  }
}
function sampleTimestamps(duration: number, count = 4): number[] {
  if (duration <= 0) return [0.0];
  if (count <= 1) return [duration / 2];
  const step = duration / (count + 1);
  return Array.from({ length: count }, (_v, i) => Math.round(step * (i + 1) * 100) / 100);
}
async function ffprobeJson(p: string): Promise<any | null> {
  try {
    const { stdout, exitCode } = await execa("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", p], { timeout: 30000, reject: false });
    if (exitCode === 0) return JSON.parse(String(stdout));
  } catch {
    /* ignore */
  }
  return null;
}

async function probeVideo(p: string, reg: Reg): Promise<Record<string, any>> {
  const result: Record<string, any> = { technical_probe: {}, representative_frames: [], quality_risks: [] };
  const ap = reg.get("audio_probe");
  if (ap) {
    try {
      const r = await ap.execute({ input_path: p });
      if (r.success) result.technical_probe = r.data ?? {};
    } catch {
      /* ignore */
    }
  }
  if (Object.keys(result.technical_probe).length === 0) {
    const probe = await ffprobeJson(p);
    if (probe) {
      const fmt = probe.format ?? {};
      const vs = (probe.streams ?? []).find((s: any) => s.codec_type === "video") ?? {};
      const as = (probe.streams ?? []).find((s: any) => s.codec_type === "audio") ?? {};
      result.technical_probe = {
        duration_seconds: parseFloat(fmt.duration ?? "0"),
        resolution: `${vs.width ?? "?"}x${vs.height ?? "?"}`,
        fps: parseFps(vs.r_frame_rate ?? "0/1"),
        codec: vs.codec_name ?? "unknown",
        audio_codec: as.codec_name ?? "",
        sample_rate: as.sample_rate ? Number(as.sample_rate) : 0,
        channels: as.channels ? Number(as.channels) : 0,
        file_size_bytes: Number(fmt.size ?? 0),
        bitrate_kbps: Math.round((Number(fmt.bit_rate ?? 0) / 1000) * 10) / 10,
      };
    } else {
      result.quality_risks.push("Could not probe file");
    }
  }
  const fsmp = reg.get("frame_sampler");
  if (fsmp) {
    try {
      const duration = result.technical_probe.duration_seconds ?? 0;
      const r = await fsmp.execute({ input_path: p, timestamps: sampleTimestamps(duration, 4), output_dir: path.join(path.dirname(p), ".source_review_frames") });
      if (r.success) result.representative_frames = r.data?.frame_paths ?? [];
    } catch {
      /* ignore */
    }
  }
  const probe = result.technical_probe;
  if (probe && Object.keys(probe).length) {
    const res = probe.resolution ?? "";
    if (res && res.includes("x")) {
      const [w, h] = res.split("x").map(Number);
      if (!Number.isNaN(w) && !Number.isNaN(h) && (w < 720 || h < 480)) result.quality_risks.push(`Low resolution (${res}) — may appear pixelated in final output`);
    }
    if (probe.channels === 1) result.quality_risks.push("Mono audio — consider if stereo output is expected");
    if ((probe.duration_seconds ?? 0) < 3) result.quality_risks.push("Very short clip (<3s) — limited usability");
  }
  return result;
}

async function probeAudio(p: string, reg: Reg): Promise<Record<string, any>> {
  const result: Record<string, any> = { technical_probe: {}, quality_risks: [] };
  const ap = reg.get("audio_probe");
  if (ap) {
    try {
      const r = await ap.execute({ input_path: p });
      if (r.success) result.technical_probe = r.data ?? {};
    } catch {
      /* ignore */
    }
  }
  if (Object.keys(result.technical_probe).length === 0) {
    const probe = await ffprobeJson(p);
    if (probe) {
      const fmt = probe.format ?? {};
      const s = (probe.streams ?? []).find((x: any) => x.codec_type === "audio") ?? {};
      result.technical_probe = {
        duration_seconds: parseFloat(fmt.duration ?? "0"),
        audio_codec: s.codec_name ?? "unknown",
        sample_rate: Number(s.sample_rate ?? 0),
        channels: Number(s.channels ?? 0),
        file_size_bytes: Number(fmt.size ?? 0),
        bitrate_kbps: Math.round((Number(fmt.bit_rate ?? 0) / 1000) * 10) / 10,
      };
    } else {
      result.quality_risks.push("Could not probe audio");
    }
  }
  return result;
}

async function probeImage(p: string): Promise<Record<string, any>> {
  const result: Record<string, any> = { technical_probe: {}, quality_risks: [] };
  try {
    const sharp = (await import("sharp")).default;
    const meta = await sharp(p).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    result.technical_probe = { resolution: `${w}x${h}`, file_size_bytes: fs.statSync(p).size, codec: (meta.format ?? "unknown").toUpperCase() };
    if (w < 640 || h < 480) result.quality_risks.push(`Low resolution (${w}x${h}) — may need upscaling`);
  } catch {
    try {
      result.technical_probe = { file_size_bytes: fs.statSync(p).size };
    } catch {
      result.quality_risks.push("Could not probe image");
    }
  }
  return result;
}

async function transcribeIfAvailable(p: string, mediaType: string, reg: Reg): Promise<string | null> {
  if (mediaType !== "video" && mediaType !== "audio") return null;
  const transcriber = reg.get("transcriber");
  if (transcriber && transcriber.getStatus() === ToolStatus.AVAILABLE) {
    try {
      const r = await transcriber.execute({ input_path: p });
      if (r.success) {
        const text = (r.data?.text as string) ?? "";
        if (text) {
          const words = text.split(/\s+/);
          if (words.length > 100) return `${words.slice(0, 100).join(" ")}... (${words.length} words total)`;
          return text;
        }
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

function inferVideoUsability(probe: Record<string, any>, transcript: string | null): string[] {
  const uses: string[] = [];
  const dur = probe.duration_seconds ?? 0;
  if (dur > 10) uses.push("hero footage");
  if (dur > 3) uses.push("b-roll");
  if (transcript) uses.push("source dialogue");
  if (probe.audio_codec) uses.push("source audio");
  return uses.length ? uses : ["short clip"];
}
function inferAudioUsability(probe: Record<string, any>, transcript: string | null): string[] {
  const uses: string[] = [];
  const dur = probe.duration_seconds ?? 0;
  if (transcript) uses.push("narration source");
  if (dur > 30) uses.push("background music candidate");
  if (dur > 5) uses.push("sound effect or ambient");
  return uses.length ? uses : ["audio clip"];
}

export async function reviewSourceMedia(files: string[], _context: Record<string, any>, toolRegistry?: Reg): Promise<Record<string, any>> {
  const reg = (toolRegistry ?? (defaultRegistry as unknown as Reg)) as Reg;
  const reviewedFiles: Array<Record<string, any>> = [];
  const allImplications: string[] = [];
  const summaries: string[] = [];

  for (const filePath of files) {
    const mediaType = detectMediaType(filePath);
    if (mediaType === null || !fs.existsSync(filePath)) continue;
    const entry: Record<string, any> = { path: filePath, media_type: mediaType, reviewed: true };
    const probeData = mediaType === "video" ? await probeVideo(filePath, reg) : mediaType === "audio" ? await probeAudio(filePath, reg) : await probeImage(filePath);
    entry.technical_probe = probeData.technical_probe ?? {};
    entry.quality_risks = probeData.quality_risks ?? [];
    entry.representative_frames = probeData.representative_frames ?? [];
    const transcript = await transcribeIfAvailable(filePath, mediaType, reg);
    if (transcript) entry.transcript_summary = transcript;
    const probe = entry.technical_probe;
    const name = path.basename(filePath);
    if (mediaType === "video") {
      const dur = probe.duration_seconds ?? 0;
      const res = probe.resolution ?? "unknown";
      entry.content_summary = `Video file: ${dur.toFixed(1)}s at ${res}, ${probe.audio_codec ? "with" : "without"} audio`;
      entry.usable_for = inferVideoUsability(probe, transcript);
    } else if (mediaType === "audio") {
      const dur = probe.duration_seconds ?? 0;
      entry.content_summary = `Audio file: ${dur.toFixed(1)}s, ${probe.audio_codec ?? "unknown"}`;
      entry.usable_for = inferAudioUsability(probe, transcript);
    } else {
      entry.content_summary = `Image file: ${probe.resolution ?? "unknown"}`;
      entry.usable_for = ["visual asset", "reference image"];
    }
    summaries.push(`${name}: ${entry.content_summary}`);
    reviewedFiles.push(entry);
    for (const risk of entry.quality_risks) allImplications.push(`Quality risk in ${name}: ${risk}`);
  }

  let summary: string;
  if (reviewedFiles.length === 0) {
    summary = "No user-supplied media files could be reviewed.";
    allImplications.push("No source media available — production is fully generated.");
  } else {
    summary = summaries.join("; ");
  }
  const hasVideo = reviewedFiles.some((f) => f.media_type === "video");
  const hasAudio = reviewedFiles.some((f) => f.media_type === "audio");
  const hasImages = reviewedFiles.some((f) => f.media_type === "image");
  if (hasVideo) allImplications.push("Source video available — consider source-led or hybrid production approach");
  if (hasAudio && !hasVideo) allImplications.push("Audio-only source — production needs visual assets to accompany audio");
  if (hasImages && !hasVideo) allImplications.push("Image-only source — motion must come from animation or video generation");
  if (allImplications.length === 0) allImplications.push("No specific constraints identified from source media.");

  return { version: "1.0", files: reviewedFiles, summary, planning_implications: allImplications };
}

export function hasUserMedia(projectDir: string): boolean {
  if (!fs.existsSync(projectDir)) return false;
  const all = new Set([...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS, ...IMAGE_EXTENSIONS]);
  try {
    return fs.readdirSync(projectDir).some((f) => all.has(path.extname(f).toLowerCase()));
  } catch {
    return false;
  }
}
