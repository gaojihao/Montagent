# Montagent → TypeScript — Acceptance Report

**Role:** unified acceptance (integrator/verifier) over three module experts.
**Date:** 2026-06-24
**Scope of this slice:** prove a **complete free (zero-API-key) flow** end-to-end on the TS port,
on top of a fully-ported framework layer, with representative tools. The full provider-tool
port (M2/M4) and full composition orchestration (M3-full/M5) remain per the plan.

---

## 1. Verdict

✅ **PASS** — the complete free flow runs end-to-end through the real `montagent` CLI and
produces a valid video, using only free/local methods (Remotion + headless Chromium). The
framework layer is ported and tested; parity with the Python original is confirmed on every
gate exercisable in this slice.

---

## 2. The complete free flow (the explicit ask: "用免费的方式走一个完整的流程")

| Step | Command | Result |
|---|---|---|
| 1. Discover capabilities | `montagent preflight --summary` | Capability menu: `video_post` 1/1 (ffmpeg available), `tts` 0/1 + `image_generation` 0/1 (with setup offers). Structurally identical to Python (§4). |
| 2. List free demos | `montagent demo --list` | 3 demos listed — **byte-identical** to Python `render_demo.py --list`. |
| 3. Render (free) | `montagent demo focusflow-pitch` | `focusflow-pitch.mp4` — 4.0 MB, **1920×1080@30, 675 frames, h264**. |

No API key, no paid call. The render uses `@remotion/renderer` programmatically (the plan's one
intentional upgrade over `npx remotion render`) — same composition, same props, same output.

### Independent ffprobe verification — all three demos (`make demo`)

| Demo | codec | resolution | fps | frames | duration | size |
|---|---|---|---|---|---|---|
| code-to-screen | h264 | 1920×1080 | 30 | 750 | 25.05 s | 3.6 MB |
| focusflow-pitch | h264 | 1920×1080 | 30 | 675 | 22.55 s | 4.0 MB |
| world-in-numbers | h264 | 1920×1080 | 30 | 690 | 23.06 s | 4.2 MB |

Each frame count = (max-cut seconds + 1 s padding) × 30 fps — matches the `Explainer`
composition's `calculateMetadata` exactly (24/21.5/22 s → 750/675/690). First render pays a
one-time Chromium-download + bundle cost (~60 s); the bundle is reused across the three.

---

## 3. Parity evidence (the plan's three gates + preflight)

| Gate | How verified | Result |
|---|---|---|
| ① Contract tests | `make test` → vitest | ✅ **29/29** (7 registry/tool + 7 checkpoint + 15 schema) |
| ② Differential (schema) | Canonical artifacts validated by **ajv against the same 24 `schemas/*.json`** the Python uses (reused verbatim). Color-math / type-scale ported bit-identical (Expert B verified 60/60). | ✅ |
| ③ E2E demo | Real render, ffprobe-confirmed 1920×1080 h264 675f | ✅ |
| ④ Preflight output | Python `provider_menu_summary()` vs TS — **identical** top-level keys `[capabilities, composition_runtimes, runtime_warnings, setup_offers]`, identical capability-entry keys `[available_providers, capability, configured, total, unavailable_providers]`, identical runtime keys `[ffmpeg, hyperframes, remotion]`, identical setup-offer keys. | ✅ |
| CLI 1:1 | `make` target names kept verbatim; `make {lint,test,demo,demo-list,preflight,install-gpu}` all behave correctly; `install-gpu` reports the GPU drop instead of running pip. | ✅ |

---

## 4. Module breakdown (3 experts in parallel + integration)

| Module | Owner | Deliverables | Self-check |
|---|---|---|---|
| Foundation + `base_tool` contract | integrator | folder, reused assets, package.json/tsconfig/workspace/Makefile, `base_tool.ts` (ToolResult/BaseTool/ToolRuntime **w/o LOCAL_GPU**, env:/cmd: deps, execa runCommand, dotenv) | tsc clean, loads |
| Registry + tools (Expert A) | sub-agent | `tool_registry.ts` (full port, explicit-index discovery), `index.ts`, `cost_tracker.ts`, `video_compose` (real render-engine detection), `elevenlabs_tts` (HTTP→fetch), `flux_image` | 7/7 tests, tsc clean |
| Persistence + loaders (Expert B) | sub-agent | `checkpoint.ts` (ajv + reused schemas), `config.ts` (zod), `pipeline_loader.ts`, `playbook_loader.ts`, `schema_validator.ts` | 22/22 tests, tsc clean |
| Remotion render (Expert C) | sub-agent | `render.ts` — programmatic `@remotion/bundler`+`@remotion/renderer`, demo discovery, `listDemos`/`renderDemo`/`renderAllDemos` | render verified |
| CLI + Makefile wiring | integrator | `cli/index.ts` (commander): preflight/catalog/runtimes/demo/hyperframes/run; Makefile 13 targets | tsc clean, all commands work |

**Whole-project typecheck (`tsc --noEmit`): clean.** **`make test`: 29/29.**

### Integration fixes applied during acceptance
- `base_tool.ts`: execa `Options` fields are readonly → build options as a literal.
- `remotion-composer/package.json`: added `@remotion/media-utils` (used by the source but
  undeclared — a latent bug that only worked under npm's hoisted layout; pnpm's strict layout
  surfaced it). Declared explicitly = the correct fix.
- `esbuild` native binary rebuilt (pnpm 10 blocks post-install scripts by default).

---

## 5. Full port status (M2–M5) — UPDATED after completing the remaining work

The slice in §1–§4 was extended to a **full port of the non-GPU tool layer**.

### Tool layer: 75 / 75 non-GPU tools ported and registered
Python had **85** registered tools; **10** are GPU/PyTorch-only and intentionally excluded
(`local_diffusion`, `cogvideo_video`, `hunyuan_video`, `wan_video`, `ltx_video_local`,
`talking_head`, `lip_sync`, `face_restore`, `upscale`, `video_understand`). The TS registry
discovers **exactly 75** tools — full count parity with Python's non-GPU set. `tsc --noEmit`
clean; `make test` 30/30; `make lint` (tsc + CI guard) clean.

| Capability | configured/total | Notes |
|---|---|---|
| tts | 0/5 | doubao, elevenlabs, google, openai, piper (+ tts_selector) — need keys/piper binary |
| image_generation | 0/8 | flux, google_imagen, grok, openai, pexels, pixabay, recraft, image_gen (+ image_selector) |
| video_generation | 0/12 | grok, heygen, higgsfield, kling, ltx_modal, minimax, pexels, pixabay, runway, seedance×2, veo (+ video_selector) |
| video_post | 9/9 | video_compose (full FFmpeg+Remotion+HyperFrames routing), stitch, trim, silence_cutter, auto_reframe, green_screen×2, showcase_card, hyperframes_compose |
| analysis | 9/10 | audio_energy/probe, frame_sampler, scene_detect, visual_qa, composition_validator, video_analyzer, transcriber (transformers.js whisper, word timestamps), transcript_fetcher; face_tracker UNAVAILABLE (mediapipe) |
| audio_processing | 2/2 | audio_enhance, audio_mixer |
| music_generation / music_search | 0/2, 1/2 | music_gen, suno; freesound, pixabay_music |
| enhancement | 3/4 | color_grade, face_enhance, bg_remove (@imgly); eye_enhance UNAVAILABLE (mediapipe) |
| graphics | 2/3 | diagram_gen (mermaid), code_snippet (shiki+canvas); math_animate UNAVAILABLE (no manim binary) |
| subtitle | 2/2 | subtitle_gen, remotion_caption_burn |
| character_animation | 6/6 | spec/rig/pose/timeline/render/review (one Python file → one TS module) |
| screen_capture | 2/2 | screen_recorder (ffmpeg), cap_recorder (+ screen_capture_selector) |
| clip_retrieval / clip_acquisition / corpus_population | 1/1, 1/1, 0/1 | clip_search, direct_clip_search, corpus_builder (DEGRADED — only keyless source configured) |
| source_ingest | 0/1 | video_downloader (yt-dlp) |

### Key non-GPU re-implementations (PyTorch removed, free CPU paths)
- **Transcription** (`transcriber`): faster-whisper/WhisperX → **`@xenova/transformers`** whisper (ONNX/CPU), ffmpeg-decoded 16 kHz audio, **word-level timestamps preserved**.
- **CLIP** (`clip_search`/`corpus_builder` via `lib/clip_embedder`): torch CLIP → `@xenova/transformers` CLIP.
- **Background removal** (`bg_remove`): rembg/onnx → **`@imgly/background-removal-node`** (lazy-loaded so discovery never touches native binaries).
- **HYBRID tools** (`image_gen`): local diffusers branch dropped, API branch kept.
- **Google auth** (`google_credentials`): `google-auth` → `node:crypto` RS256 JWT-bearer flow (no dependency).

### lib layer
Ported: `checkpoint` (+ajv schema reuse), `config` (zod), `pipeline_loader`, `scoring`,
`corpus` (+minimal `.npy` r/w), `clip_embedder`, `schema_validator`, `google_credentials`,
`shot_prompt_builder`, plus `cost_tracker` under tools/.

### Instruction layer (M5)
- Copied verbatim: 151 skills, 69 Layer-3 packs, AGENT_GUIDE.md, PROJECT_CONTEXT.md.
- **Codemod** (`scripts/codemod-skill-commands.mjs`): every embedded `python -c "from tools…"`
  rewritten to the matching `montagent` subcommand (preflight/preflight --summary/catalog/envelope/runtimes).
- **CI guard**: `make guard` + `tests/contracts/instruction_commands.test.ts` fail if any
  `python -c "from tools…"` remains. Verified 0 across 548 instruction files.

### Free-flow regression
After the full port + codemod, `montagent demo focusflow-pitch` still renders a valid
1920×1080 h264 / 675-frame mp4 — no regression.

### 1:1 closure (re-audit) — all earlier deferrals now ported

A full Python-vs-TS diff confirms one-to-one correspondence except the GPU/PyTorch exemption:

- **stock_sources adapters: 16/16** (was 2/16). All ported against the `StockSource`
  framework: pexels, archive_org, pixabay_video, unsplash, coverr, videvo, nasa, wikimedia,
  pond5_pd, dareful, mixkit, nara, loc, noaa, esa, jaxa. (HTML-scraper adapters use `cheerio`
  in place of BeautifulSoup.) `direct_clip_search`/`corpus_builder` now fan out over all 16.
- **lib modules: complete.** Added delivery_promise, slideshow_risk, verify_scene_pacing,
  variation_checker, source_media_review, playbook_generator, media_profiles,
  hyperframes_style_bridge, shot_prompt_builder, env_loader (the last is a no-op shim — base_tool
  loads .env via dotenv). `config_model` → `config.ts`.
- **clip_cache** ported (LRU bytes cache, O_EXCL lock) and **wired into `corpus_builder`**
  (try-link before download, ingest after, cache stats in the result) — replacing the earlier no-op.

Re-audit result: `stock_sources` py=16/ts=16 (0 missing), `lib` 0 missing, `clip_cache` present,
75/75 non-GPU tools, `make lint` PASS, `make test` 30/30, free-flow render unchanged. A file-level
smoke instantiates the clip subsystem and every lib helper without error.

GPU/PyTorch tools remain intentionally absent (the one sanctioned exemption).

