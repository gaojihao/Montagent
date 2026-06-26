/**
 * Tool catalog — the explicit registry of all concrete BaseTool classes.
 *
 * This REPLACES Python's pkgutil/inspect reflection (tools.tool_registry.discover
 * walking the package tree). registry.discover() instantiates every class in
 * ALL_TOOLS and registers it. Adding a new tool = add its class here.
 *
 * NOTE: cost_tracker is intentionally NOT included — plain state class, not a BaseTool.
 * GPU/PyTorch-only tools (local_diffusion, cogvideo/hunyuan/wan/ltx_local, talking_head,
 * lip_sync, face_restore, upscale, video_understand) are intentionally absent.
 */
import type { BaseTool } from "./base_tool.js";

// analysis
import { AudioEnergy } from "./analysis/audio_energy.js";
import { AudioProbe } from "./analysis/audio_probe.js";
import { CompositionValidator } from "./analysis/composition_validator.js";
import { FaceTracker } from "./analysis/face_tracker.js";
import { FrameSampler } from "./analysis/frame_sampler.js";
import { SceneDetect } from "./analysis/scene_detect.js";
import { Transcriber } from "./analysis/transcriber.js";
import { TranscriptFetcher } from "./analysis/transcript_fetcher.js";
import { VideoAnalyzer } from "./analysis/video_analyzer.js";
import { VideoDownloader } from "./analysis/video_downloader.js";
import { VisualQA } from "./analysis/visual_qa.js";

// audio_processing
import { AudioEnhance } from "./audio/audio_enhance.js";
import { AudioMixer } from "./audio/audio_mixer.js";

// capture (screen_capture)
import { CapRecorder } from "./capture/cap_recorder.js";
import { ScreenCaptureSelector } from "./capture/screen_capture_selector.js";
import { ScreenRecorder } from "./capture/screen_recorder.js";

// character_animation
import {
  ActionTimelineCompiler,
  CharacterAnimationReviewer,
  CharacterRigRenderer,
  CharacterSpecGenerator,
  PoseLibraryBuilder,
  SvgRigBuilder,
} from "./character/character_animation.js";

// enhancement
import { BgRemove } from "./enhancement/bg_remove.js";
import { ColorGrade } from "./enhancement/color_grade.js";
import { EyeEnhance } from "./enhancement/eye_enhance.js";
import { FaceEnhance } from "./enhancement/face_enhance.js";

// graphics
import { CodeSnippet } from "./graphics/code_snippet.js";
import { DiagramGen } from "./graphics/diagram_gen.js";
import { MathAnimate } from "./graphics/math_animate.js";

// image_generation
import { FluxImage } from "./image/flux_image.js";
import { GoogleImagen } from "./image/google_imagen.js";
import { GrokImage } from "./image/grok_image.js";
import { ImageGen } from "./image/image_gen.js";
import { ImageSelector } from "./image/image_selector.js";
import { OpenAIImage } from "./image/openai_image.js";
import { PexelsImage } from "./image/pexels_image.js";
import { PixabayImage } from "./image/pixabay_image.js";
import { RecraftImage } from "./image/recraft_image.js";

// music
import { FreesoundMusic } from "./music/freesound_music.js";
import { MusicGen } from "./music/music_gen.js";
import { PixabayMusic } from "./music/pixabay_music.js";
import { SunoMusic } from "./music/suno_music.js";

// subtitle
import { SubtitleGen } from "./subtitle/subtitle_gen.js";

// tts
import { DoubaoTTS } from "./tts/doubao_tts.js";
import { ElevenLabsTTS } from "./tts/elevenlabs_tts.js";
import { GoogleTTS } from "./tts/google_tts.js";
import { OpenAITTS } from "./tts/openai_tts.js";
import { PiperTTS } from "./tts/piper_tts.js";
import { TTSSelector } from "./tts/tts_selector.js";

// video (generation + post)
import { AutoReframe } from "./video/auto_reframe.js";
import { DoubaoSeedanceVideo } from "./video/doubao_seedance_video.js";
import { GreenScreenComposite } from "./video/green_screen_composite.js";
import { GreenScreenProcessor } from "./video/green_screen_processor.js";
import { GrokVideo } from "./video/grok_video.js";
import { HeyGenVideo } from "./video/heygen_video.js";
import { HiggsFieldVideo } from "./video/higgsfield_video.js";
import { HyperFramesCompose } from "./video/hyperframes_compose.js";
import { KlingVideo } from "./video/kling_video.js";
import { LTXVideoModal } from "./video/ltx_video_modal.js";
import { MiniMaxVideo } from "./video/minimax_video.js";
import { PexelsVideo } from "./video/pexels_video.js";
import { PixabayVideo } from "./video/pixabay_video.js";
import { RemotionCaptionBurn } from "./video/remotion_caption_burn.js";
import { RunwayVideo } from "./video/runway_video.js";
import { SeedanceReplicate } from "./video/seedance_replicate.js";
import { SeedanceVideo } from "./video/seedance_video.js";
import { ShowcaseCard } from "./video/showcase_card.js";
import { SilenceCutter } from "./video/silence_cutter.js";
import { VeoVideo } from "./video/veo_video.js";
import { VideoCompose } from "./video/video_compose.js";
import { VideoSelector } from "./video/video_selector.js";
import { VideoStitch } from "./video/video_stitch.js";
import { VideoTrimmer } from "./video/video_trimmer.js";
import { ClipSearch } from "./video/clip_search.js";
import { DirectClipSearch } from "./video/direct_clip_search.js";
import { CorpusBuilder } from "./video/corpus_builder.js";

export const ALL_TOOLS: Array<new () => BaseTool> = [
  // analysis
  AudioEnergy,
  AudioProbe,
  CompositionValidator,
  FaceTracker,
  FrameSampler,
  SceneDetect,
  Transcriber,
  TranscriptFetcher,
  VideoAnalyzer,
  VideoDownloader,
  VisualQA,
  // audio_processing
  AudioEnhance,
  AudioMixer,
  // capture
  CapRecorder,
  ScreenCaptureSelector,
  ScreenRecorder,
  // character_animation
  ActionTimelineCompiler,
  CharacterAnimationReviewer,
  CharacterRigRenderer,
  CharacterSpecGenerator,
  PoseLibraryBuilder,
  SvgRigBuilder,
  // enhancement
  BgRemove,
  ColorGrade,
  EyeEnhance,
  FaceEnhance,
  // graphics
  CodeSnippet,
  DiagramGen,
  MathAnimate,
  // image_generation
  FluxImage,
  GoogleImagen,
  GrokImage,
  ImageGen,
  ImageSelector,
  OpenAIImage,
  PexelsImage,
  PixabayImage,
  RecraftImage,
  // music
  FreesoundMusic,
  MusicGen,
  PixabayMusic,
  SunoMusic,
  // subtitle
  SubtitleGen,
  // tts
  DoubaoTTS,
  ElevenLabsTTS,
  GoogleTTS,
  OpenAITTS,
  PiperTTS,
  TTSSelector,
  // video (generation + post)
  AutoReframe,
  DoubaoSeedanceVideo,
  GreenScreenComposite,
  GreenScreenProcessor,
  GrokVideo,
  HeyGenVideo,
  HiggsFieldVideo,
  HyperFramesCompose,
  KlingVideo,
  LTXVideoModal,
  MiniMaxVideo,
  PexelsVideo,
  PixabayVideo,
  RemotionCaptionBurn,
  RunwayVideo,
  SeedanceReplicate,
  SeedanceVideo,
  ShowcaseCard,
  SilenceCutter,
  VeoVideo,
  VideoCompose,
  VideoSelector,
  VideoStitch,
  VideoTrimmer,
  // clip_retrieval / clip_acquisition / corpus_population
  ClipSearch,
  DirectClipSearch,
  CorpusBuilder,
];
