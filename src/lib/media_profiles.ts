/** Media profile constants + render-profile helpers (TS port of lib/media_profiles.py). */
export enum AspectRatio {
  LANDSCAPE_16_9 = "16:9",
  PORTRAIT_9_16 = "9:16",
  SQUARE_1_1 = "1:1",
  CINEMATIC_21_9 = "21:9",
  STANDARD_4_3 = "4:3",
}

export interface MediaProfile {
  name: string;
  width: number;
  height: number;
  aspect_ratio: AspectRatio;
  fps: number;
  codec: string;
  audio_codec: string;
  crf: number;
  pixel_format: string;
  max_file_size_mb: number | null;
  max_duration_seconds: number | null;
  caption_format: string;
  notes: string;
}

function profile(p: Partial<MediaProfile> & Pick<MediaProfile, "name" | "width" | "height" | "aspect_ratio" | "fps" | "crf">): MediaProfile {
  return {
    codec: "libx264",
    audio_codec: "aac",
    pixel_format: "yuv420p",
    max_file_size_mb: null,
    max_duration_seconds: null,
    caption_format: "srt",
    notes: "",
    ...p,
  };
}

export const YOUTUBE_LANDSCAPE = profile({ name: "youtube_landscape", width: 1920, height: 1080, aspect_ratio: AspectRatio.LANDSCAPE_16_9, fps: 30, crf: 18, notes: "YouTube standard HD upload" });
export const YOUTUBE_4K = profile({ name: "youtube_4k", width: 3840, height: 2160, aspect_ratio: AspectRatio.LANDSCAPE_16_9, fps: 30, crf: 18, notes: "YouTube 4K upload" });
export const YOUTUBE_SHORTS = profile({ name: "youtube_shorts", width: 1080, height: 1920, aspect_ratio: AspectRatio.PORTRAIT_9_16, fps: 30, crf: 20, max_duration_seconds: 60, notes: "YouTube Shorts (max 60s, vertical)" });
export const INSTAGRAM_REELS = profile({ name: "instagram_reels", width: 1080, height: 1920, aspect_ratio: AspectRatio.PORTRAIT_9_16, fps: 30, crf: 20, max_file_size_mb: 250, max_duration_seconds: 90, notes: "Instagram Reels (max 90s, vertical)" });
export const INSTAGRAM_FEED = profile({ name: "instagram_feed", width: 1080, height: 1080, aspect_ratio: AspectRatio.SQUARE_1_1, fps: 30, crf: 20, max_file_size_mb: 250, max_duration_seconds: 60, notes: "Instagram feed video (square)" });
export const TIKTOK = profile({ name: "tiktok", width: 1080, height: 1920, aspect_ratio: AspectRatio.PORTRAIT_9_16, fps: 30, crf: 20, max_file_size_mb: 287, max_duration_seconds: 600, notes: "TikTok (max 10min, vertical preferred)" });
export const LINKEDIN = profile({ name: "linkedin", width: 1920, height: 1080, aspect_ratio: AspectRatio.LANDSCAPE_16_9, fps: 30, crf: 20, max_file_size_mb: 5120, max_duration_seconds: 600, notes: "LinkedIn video (landscape preferred, max 10min)" });
export const CINEMATIC = profile({ name: "cinematic", width: 2560, height: 1080, aspect_ratio: AspectRatio.CINEMATIC_21_9, fps: 24, crf: 16, notes: "Cinematic ultra-wide format" });
export const GENERIC_HD = profile({ name: "generic_hd", width: 1920, height: 1080, aspect_ratio: AspectRatio.LANDSCAPE_16_9, fps: 30, crf: 23, notes: "Generic HD output (no platform-specific constraints)" });

export const ALL_PROFILES: Record<string, MediaProfile> = Object.fromEntries(
  [YOUTUBE_LANDSCAPE, YOUTUBE_4K, YOUTUBE_SHORTS, INSTAGRAM_REELS, INSTAGRAM_FEED, TIKTOK, LINKEDIN, CINEMATIC, GENERIC_HD].map((p) => [p.name, p])
);

export function getProfile(name: string): MediaProfile {
  const p = ALL_PROFILES[name];
  if (!p) throw new Error(`Unknown profile '${name}'. Available: ${Object.keys(ALL_PROFILES).join(", ")}`);
  return p;
}

export function getProfilesForPlatform(platform: string): MediaProfile[] {
  return Object.entries(ALL_PROFILES).filter(([name]) => name.startsWith(platform)).map(([, p]) => p);
}

export function ffmpegOutputArgs(p: MediaProfile): string[] {
  return ["-c:v", p.codec, "-c:a", p.audio_codec, "-crf", String(p.crf), "-pix_fmt", p.pixel_format, "-r", String(p.fps), "-vf", `scale=${p.width}:${p.height}`];
}
