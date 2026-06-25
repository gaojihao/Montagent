/**
 * HyperFrames composition tool — HTML/CSS/GSAP render path.
 *
 * TypeScript port of tools/video/hyperframes_compose.py. Sibling to
 * `video_compose` (FFmpeg + Remotion). This tool owns the HyperFrames runtime
 * end-to-end: workspace materialization, `hyperframes lint`,
 * `hyperframes validate`, and `hyperframes render`. It is invoked by
 * `video_compose` when `edit_decisions.render_runtime == "hyperframes"`, and
 * can also be called directly (lint-only, validate-only, scaffold-only).
 *
 * Parity notes vs. Python:
 *  - name/capability/provider/runtime/tier/stability/dependencies match verbatim.
 *  - The HyperFrames CLI is invoked via `npx --yes hyperframes <args>` (execa,
 *    reject:false) so the caller parses lint/validate/render exit codes itself —
 *    the same reason the Python version bypasses self.run_command.
 *  - Runtime check verifies node >= 22 + ffmpeg + npx on PATH AND that the
 *    `hyperframes` npm package resolves (`npm view hyperframes version`, 5s,
 *    cached per process). get_info() exposes hyperframes_runtime (incl. reasons),
 *    which the registry's providerMenuSummary reads.
 *  - lib.media_profiles / lib.hyperframes_style_bridge / styles.playbook_loader
 *    are optional: profile resolution falls back to 1920x1080@fps and the style
 *    bridge uses the built-in fallback when the module is unavailable (the same
 *    behavior as Python catching the import error).
 */
import fs from "node:fs";
import path from "node:path";
import { execa, execaSync } from "execa";
import {
  BaseTool,
  Determinism,
  ExecutionMode,
  ResourceProfile,
  ResumeSupport,
  RetryPolicy,
  ToolResult,
  ToolRuntime,
  ToolStability,
  ToolStatus,
  ToolTier,
  commandExists,
  toolResult,
} from "../base_tool.js";

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".bmp",
  ".tiff",
  ".tif",
  ".webp",
  ".gif",
]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".mkv", ".m4v"]);

// ---------------------------------------------------------------------------
// Minimal media-profile registry (width/height/fps only — the parts used here).
// Mirrors lib/media_profiles.py; inline because the TS port has no such module.
// ---------------------------------------------------------------------------
const MEDIA_PROFILES: Record<
  string,
  { width: number; height: number; fps: number }
> = {
  youtube_landscape: { width: 1920, height: 1080, fps: 30 },
  youtube_4k: { width: 3840, height: 2160, fps: 30 },
  youtube_shorts: { width: 1080, height: 1920, fps: 30 },
  instagram_reels: { width: 1080, height: 1920, fps: 30 },
  instagram_feed: { width: 1080, height: 1080, fps: 30 },
  tiktok: { width: 1080, height: 1920, fps: 30 },
  linkedin: { width: 1920, height: 1080, fps: 30 },
  cinematic: { width: 2560, height: 1080, fps: 24 },
  generic_hd: { width: 1920, height: 1080, fps: 30 },
};

interface RuntimeCheck {
  runtime_available: boolean;
  node_major: number | null;
  ffmpeg_available: boolean;
  npx_available: boolean;
  npm_package: string;
  npm_package_version: string | null;
  npm_resolve_error: string | null;
  reasons: string[];
}

interface ProcResult {
  returncode: number;
  stdout: string;
  stderr: string;
}

export class HyperFramesCompose extends BaseTool {
  override name = "hyperframes_compose";
  override version = "0.1.0";
  override tier = ToolTier.CORE;
  override capability = "video_post";
  override provider = "hyperframes";
  override stability = ToolStability.BETA;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;
  override runtime = ToolRuntime.LOCAL;

  override dependencies = ["cmd:npx", "cmd:ffmpeg"];
  override install_instructions =
    "Requires Node.js >= 22 (https://nodejs.org/) and FFmpeg " +
    "(https://ffmpeg.org/download.html). The HyperFrames CLI is fetched " +
    "on first use via `npx hyperframes` (npm package: `hyperframes`). " +
    "Note: the upstream monorepo develops the package as `@hyperframes/cli`, " +
    "but it publishes to npm as `hyperframes`. `npx @hyperframes/cli` " +
    "returns 404 -- do NOT use that form. Verify setup with " +
    "`npx hyperframes doctor` or run the `doctor` operation on this tool.";
  override agent_skills = [
    "hyperframes",
    "hyperframes-cli",
    "hyperframes-registry",
    "website-to-hyperframes",
    "gsap-core",
    "gsap-timeline",
  ];

  override capabilities = [
    "hyperframes_render",
    "hyperframes_lint",
    "hyperframes_validate",
    "hyperframes_doctor",
    "scaffold_workspace",
    "add_block",
  ];

  override best_for = [
    "HTML/CSS/GSAP composition: kinetic typography, product promos, launch reels",
    "Motion-graphics-heavy briefs where the scene library in remotion-composer/ doesn't fit",
    "Website-to-video / UI-driven compositions",
    "Registry-block-driven scenes (hyperframes add data-chart, grain-overlay, etc.)",
  ];
  override not_good_for = [
    "Word-level caption burn (stays on Remotion in Phase 1)",
    "Avatar / lip-sync presenter (stays on Remotion in Phase 1)",
    "Existing React scene stack (text_card, stat_card, chart, comparison): reuse Remotion",
  ];
  override fallback_tools = ["video_compose"];

  override input_schema = {
    type: "object",
    required: ["operation"],
    properties: {
      operation: {
        type: "string",
        enum: [
          "render",
          "lint",
          "validate",
          "doctor",
          "scaffold_workspace",
          "add_block",
        ],
        description:
          "render: materialize workspace + lint + validate + render to MP4. " +
          "lint: run `hyperframes lint` on an existing workspace. " +
          "validate: run `hyperframes validate` (browser-based). " +
          "doctor: run `hyperframes doctor` to check environment. " +
          "scaffold_workspace: materialize HTML/CSS/assets but do not render. " +
          "add_block: run `hyperframes add <name>` to install a registry " +
          "block or component into an existing workspace.",
      },
      block_name: {
        type: "string",
        description:
          "Registry block or component name for operation='add_block' " +
          "(e.g. 'data-chart', 'grain-overlay', 'shimmer-sweep'). " +
          "See https://hyperframes.heygen.com/catalog for the list.",
      },
      workspace_path: {
        type: "string",
        description:
          "Target HyperFrames workspace directory. Typically " +
          "`projects/<name>/hyperframes/`. Required for every op except doctor.",
      },
      output_path: {
        type: "string",
        description: "Output MP4 path. Used by operation='render'.",
      },
      edit_decisions: {
        type: "object",
        description:
          "Full edit_decisions artifact — required for render and " +
          "scaffold_workspace. Used to generate index.html + CSS.",
      },
      asset_manifest: {
        type: "object",
        description:
          "Full asset_manifest artifact — required for render and " +
          "scaffold_workspace. Used to resolve asset IDs to file paths.",
      },
      playbook: {
        type: "object",
        description:
          "Loaded playbook dict. Used to drive the style bridge " +
          "(CSS custom properties, typography, motion defaults).",
      },
      profile: {
        type: "string",
        description:
          "Media profile name (youtube_landscape, tiktok_vertical, etc.).",
      },
      quality: {
        type: "string",
        enum: ["draft", "standard", "high"],
        default: "standard",
        description:
          "Render quality. `draft` for iterating, `high` for delivery.",
      },
      fps: {
        type: "integer",
        enum: [24, 30, 60],
        default: 30,
      },
      strict: {
        type: "boolean",
        default: false,
        description:
          "If true, fail the render on any lint error. Matches " +
          "`hyperframes render --strict`.",
      },
      skip_contrast: {
        type: "boolean",
        default: false,
        description:
          "Skip the WCAG contrast audit during validate. Acceptable " +
          "while iterating; forbidden for final delivery.",
      },
    },
  };

  override resource_profile: ResourceProfile = {
    cpu_cores: 4,
    ram_mb: 3072,
    vram_mb: 0,
    disk_mb: 2000,
    network_required: false,
  };
  override retry_policy: RetryPolicy = {
    max_retries: 0,
    backoff_seconds: 1.0,
    retryable_errors: [],
  };
  override resume_support = ResumeSupport.FROM_START;
  override idempotency_key_fields = [
    "operation",
    "workspace_path",
    "edit_decisions",
  ];
  override side_effects = [
    "writes HTML/CSS/JS files into workspace_path",
    "copies asset files into workspace_path/assets/",
    "writes MP4 to output_path",
  ];
  override user_visible_verification = [
    "Play the rendered MP4 and verify scene pacing, typography, and audio",
    "Inspect workspace_path/index.html in a browser via `npx hyperframes preview`",
  ];

  // ------------------------------------------------------------------
  // Status / availability
  // ------------------------------------------------------------------
  private static readonly NODE_FLOOR_MAJOR = 22;
  private static readonly NPM_PACKAGE = "hyperframes";
  // Process-level cache for the npm resolve check (shared across instances):
  //   {version}  → package resolves; {error} → resolution failed.
  private static npmResolveCache: { version?: string; error?: string } | null =
    null;

  /** Return Node.js major version, or null if node isn't installed. */
  private static nodeMajorVersion(): number | null {
    if (!commandExists("node")) return null;
    try {
      const out = runSync("node", ["--version"], 5000);
      if (out.exitCode !== 0) return null;
      const m = /^v?(\d+)\./.exec(out.stdout.trim());
      if (!m) return null;
      return parseInt(m[1], 10);
    } catch {
      return null;
    }
  }

  /**
   * Verify the `hyperframes` npm package actually resolves via
   * `npm view hyperframes version` (5s, cached). Returns {version} on success
   * or {error} on any failure. Never throws.
   */
  private static resolveNpmPackage(): { version?: string; error?: string } {
    if (HyperFramesCompose.npmResolveCache !== null) {
      return HyperFramesCompose.npmResolveCache;
    }

    if (!commandExists("npm")) {
      HyperFramesCompose.npmResolveCache = { error: "npm not on PATH" };
      return HyperFramesCompose.npmResolveCache;
    }

    let proc: { exitCode: number; stdout: string; stderr: string; timedOut?: boolean };
    try {
      proc = runSync("npm", ["view", HyperFramesCompose.NPM_PACKAGE, "version"], 5000);
    } catch (e: any) {
      if (e && e.timedOut) {
        HyperFramesCompose.npmResolveCache = {
          error: "timeout (5s) — offline or slow registry",
        };
      } else {
        HyperFramesCompose.npmResolveCache = {
          error: `npm view failed: ${e?.shortMessage ?? e?.name ?? "error"}`,
        };
      }
      return HyperFramesCompose.npmResolveCache;
    }

    if (proc.timedOut) {
      HyperFramesCompose.npmResolveCache = {
        error: "timeout (5s) — offline or slow registry",
      };
      return HyperFramesCompose.npmResolveCache;
    }

    if (proc.exitCode !== 0) {
      const stderr = (proc.stderr ?? "").trim();
      if (stderr.includes("404") || stderr.includes("E404")) {
        HyperFramesCompose.npmResolveCache = {
          error: `npm package \`${HyperFramesCompose.NPM_PACKAGE}\` not found (404)`,
        };
      } else {
        const lines = stderr.split("\n").filter(Boolean);
        const tail =
          lines.length > 0
            ? lines[lines.length - 1].slice(0, 200)
            : `exit ${proc.exitCode}`;
        HyperFramesCompose.npmResolveCache = {
          error: `npm view failed: ${tail}`,
        };
      }
      return HyperFramesCompose.npmResolveCache;
    }

    const version = (proc.stdout ?? "").trim();
    if (!version) {
      HyperFramesCompose.npmResolveCache = {
        error: "npm view returned empty version",
      };
    } else {
      HyperFramesCompose.npmResolveCache = { version };
    }
    return HyperFramesCompose.npmResolveCache;
  }

  /**
   * Return availability state for the HyperFrames runtime. Public so
   * `video_compose` can gate render_runtime='hyperframes' on it (mirrors the
   * Python `_runtime_check`, which is consumed by video_compose too).
   */
  runtimeCheck(): RuntimeCheck {
    const nodeMajor = HyperFramesCompose.nodeMajorVersion();
    const ffmpegOk = commandExists("ffmpeg");
    const npxOk = commandExists("npx");

    const reasons: string[] = [];
    if (nodeMajor === null) {
      reasons.push("node not found on PATH");
    } else if (nodeMajor < HyperFramesCompose.NODE_FLOOR_MAJOR) {
      reasons.push(
        `node major version ${nodeMajor} < required ${HyperFramesCompose.NODE_FLOOR_MAJOR}`
      );
    }
    if (!npxOk) reasons.push("npx not found on PATH");
    if (!ffmpegOk) reasons.push("ffmpeg not found on PATH");

    let npmResolve: { version?: string; error?: string } = {};
    if (reasons.length === 0) {
      npmResolve = HyperFramesCompose.resolveNpmPackage();
      if (npmResolve.error) {
        reasons.push(
          `npm package \`${HyperFramesCompose.NPM_PACKAGE}\` not resolvable: ${npmResolve.error}`
        );
      }
    }

    return {
      runtime_available: reasons.length === 0,
      node_major: nodeMajor,
      ffmpeg_available: ffmpegOk,
      npx_available: npxOk,
      npm_package: HyperFramesCompose.NPM_PACKAGE,
      npm_package_version: npmResolve.version ?? null,
      npm_resolve_error: npmResolve.error ?? null,
      reasons,
    };
  }

  override getStatus(): ToolStatus {
    return this.runtimeCheck().runtime_available
      ? ToolStatus.AVAILABLE
      : ToolStatus.UNAVAILABLE;
  }

  /**
   * Surface the runtime check (incl. `reasons`) and a setup offer. The
   * registry's providerMenuSummary reads hyperframes_runtime.reasons.
   */
  protected override extraInfo(): Record<string, unknown> {
    const check = this.runtimeCheck();
    const info: Record<string, unknown> = {
      hyperframes_runtime: check,
    };
    if (!check.runtime_available) {
      info.setup_offer = {
        effort:
          check.npx_available && check.ffmpeg_available
            ? "1-minute fix"
            : "5-minute fix (install Node 22+ and/or FFmpeg)",
        install_instructions: this.install_instructions,
        unlocks:
          "HTML/CSS/GSAP composition runtime — kinetic typography, " +
          "product promos, registry blocks, website-to-video.",
      };
    }
    return info;
  }

  override estimateCost(_inputs: Record<string, unknown>): number {
    return 0.0;
  }

  override estimateRuntime(inputs: Record<string, unknown>): number {
    const ed = (inputs.edit_decisions as Record<string, any>) ?? {};
    const cuts = (ed.cuts as any[]) ?? [];
    let total = 0.0;
    for (const c of cuts) {
      const outS = Number(c.out_seconds ?? 0) || 0;
      const inS = Number(c.in_seconds ?? 0) || 0;
      total += Math.max(0.0, outS - inS);
    }
    return 30.0 + total * 0.5;
  }

  // ------------------------------------------------------------------
  // Execute
  // ------------------------------------------------------------------
  override async execute(
    inputs: Record<string, unknown>
  ): Promise<ToolResult> {
    const operation = inputs.operation as string;
    const start = Date.now();
    let result: ToolResult;
    try {
      if (operation === "doctor") {
        result = await this.doctor(inputs);
      } else if (operation === "scaffold_workspace") {
        result = this.scaffold(inputs);
      } else if (operation === "lint") {
        result = await this.lint(inputs);
      } else if (operation === "validate") {
        result = await this.validate(inputs);
      } else if (operation === "render") {
        result = await this.render(inputs);
      } else if (operation === "add_block") {
        result = await this.addBlock(inputs);
      } else {
        return toolResult({
          success: false,
          error: `Unknown operation: ${operation}`,
        });
      }
    } catch (e) {
      return toolResult({
        success: false,
        error: `${e instanceof Error ? e.constructor.name : "Error"}: ${errMsg(e)}`,
      });
    }

    result.duration_seconds = Math.round((Date.now() - start) / 10) / 100;
    return result;
  }

  // ------------------------------------------------------------------
  // Operations
  // ------------------------------------------------------------------
  private async doctor(_inputs: Record<string, unknown>): Promise<ToolResult> {
    const check = this.runtimeCheck();
    const out: Record<string, any> = { runtime_check: check };

    if (!check.runtime_available) {
      return toolResult({
        success: false,
        error:
          "HyperFrames runtime floor not met: " + check.reasons.join("; "),
        data: out,
      });
    }

    try {
      const proc = await this.runHf(["doctor"], { cwd: null, timeout: 180 });
      out.cli_doctor = {
        exit_code: proc.returncode,
        stdout_tail: (proc.stdout ?? "").slice(-4000),
        stderr_tail: (proc.stderr ?? "").slice(-4000),
      };
      const ok = proc.returncode === 0;
      return toolResult({
        success: ok,
        data: out,
        error: ok ? null : `hyperframes doctor exit ${proc.returncode}`,
      });
    } catch (e) {
      out.cli_doctor_error = errMsg(e);
      return toolResult({
        success: false,
        error: `hyperframes doctor failed: ${errMsg(e)}`,
        data: out,
      });
    }
  }

  private scaffold(inputs: Record<string, unknown>): ToolResult {
    const workspace = HyperFramesCompose.requireWorkspace(inputs);
    const editDecisions = (inputs.edit_decisions as Record<string, any>) ?? {};
    const assetManifest = (inputs.asset_manifest as Record<string, any>) ?? {};
    const playbook = (inputs.playbook as Record<string, any>) ?? {};
    const profileName = inputs.profile as string | undefined;

    if (!editDecisions.cuts || (editDecisions.cuts as any[]).length === 0) {
      return toolResult({
        success: false,
        error:
          "edit_decisions with non-empty cuts[] is required for scaffold_workspace",
      });
    }

    const [width, height, fps] = HyperFramesCompose.resolveDimensions(
      profileName,
      (inputs.fps as number) ?? 30
    );

    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(path.join(workspace, "compositions"), { recursive: true });
    const assetsDir = path.join(workspace, "assets");
    fs.mkdirSync(assetsDir, { recursive: true });

    const [resolvedCuts, assetCopies] = this.resolveAndStageAssets(
      (editDecisions.cuts as any[]) ?? [],
      (assetManifest.assets as any[]) ?? [],
      workspace
    );

    const audioRefs = this.resolveAudioRefs(
      (editDecisions.audio as Record<string, any>) ?? {},
      (assetManifest.assets as any[]) ?? [],
      workspace
    );

    const [cssVars, designMd] = this.styleBridge(playbook, editDecisions);

    fs.writeFileSync(
      path.join(workspace, "hyperframes.json"),
      JSON.stringify(
        {
          registry:
            "https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry",
          paths: {
            blocks: "compositions",
            components: "compositions/components",
            assets: "assets",
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    if (designMd) {
      fs.writeFileSync(path.join(workspace, "DESIGN.md"), designMd, "utf-8");
    }

    const totalDuration =
      HyperFramesCompose.computeTotalDuration(resolvedCuts);
    const title =
      (editDecisions.metadata as Record<string, any>)?.title ??
      `Montagent ${editDecisions.renderer_family ?? "composition"}`;
    const html = this.generateIndexHtml({
      cuts: resolvedCuts,
      audioRefs,
      width,
      height,
      totalDuration,
      cssVars,
      title,
    });
    fs.writeFileSync(path.join(workspace, "index.html"), html, "utf-8");

    return toolResult({
      success: true,
      data: {
        operation: "scaffold_workspace",
        workspace,
        width,
        height,
        fps,
        total_duration_seconds: totalDuration,
        cut_count: resolvedCuts.length,
        asset_copies: assetCopies,
      },
      artifacts: [path.join(workspace, "index.html")],
    });
  }

  private async lint(inputs: Record<string, unknown>): Promise<ToolResult> {
    const workspace = HyperFramesCompose.requireWorkspace(inputs);
    if (!fs.existsSync(path.join(workspace, "index.html"))) {
      return toolResult({
        success: false,
        error: `No index.html in ${workspace}. Run scaffold_workspace first.`,
      });
    }
    const proc = await this.runHf(["lint", "--json"], {
      cwd: workspace,
      timeout: 120,
    });
    const data: Record<string, any> = { exit_code: proc.returncode };
    const payload = HyperFramesCompose.parseJsonOutput(proc.stdout);
    if (payload !== null) {
      data.report = payload;
    } else {
      data.stdout_tail = (proc.stdout ?? "").slice(-4000);
    }
    data.stderr_tail = (proc.stderr ?? "").slice(-2000);
    const ok = proc.returncode === 0;
    return toolResult({
      success: ok,
      data,
      error: ok ? null : `hyperframes lint exit ${proc.returncode}`,
    });
  }

  private async validate(
    inputs: Record<string, unknown>
  ): Promise<ToolResult> {
    const workspace = HyperFramesCompose.requireWorkspace(inputs);
    if (!fs.existsSync(path.join(workspace, "index.html"))) {
      return toolResult({
        success: false,
        error: `No index.html in ${workspace}. Run scaffold_workspace first.`,
      });
    }
    const args = ["validate", "--json"];
    if (inputs.skip_contrast) args.push("--no-contrast");
    const proc = await this.runHf(args, { cwd: workspace, timeout: 300 });
    const data: Record<string, any> = { exit_code: proc.returncode };
    const payload = HyperFramesCompose.parseJsonOutput(proc.stdout);
    if (payload !== null) {
      data.report = payload;
    } else {
      data.stdout_tail = (proc.stdout ?? "").slice(-4000);
    }
    data.stderr_tail = (proc.stderr ?? "").slice(-2000);
    const ok = proc.returncode === 0;
    return toolResult({
      success: ok,
      data,
      error: ok ? null : `hyperframes validate exit ${proc.returncode}`,
    });
  }

  private async addBlock(
    inputs: Record<string, unknown>
  ): Promise<ToolResult> {
    const workspace = HyperFramesCompose.requireWorkspace(inputs);
    const block = String(inputs.block_name ?? "").trim();
    if (!block) {
      return toolResult({
        success: false,
        error: "block_name is required for operation='add_block'",
      });
    }
    if (!fs.existsSync(workspace)) {
      return toolResult({
        success: false,
        error:
          `Workspace ${workspace} does not exist. Run ` +
          "operation='scaffold_workspace' first.",
      });
    }
    const args = ["add", block, "--json", "--no-clipboard"];
    const proc = await this.runHf(args, { cwd: workspace, timeout: 300 });
    const data: Record<string, any> = {
      operation: "add_block",
      block_name: block,
      workspace,
      exit_code: proc.returncode,
    };
    const payload = HyperFramesCompose.parseJsonOutput(proc.stdout);
    if (payload !== null) {
      data.report = payload;
    } else {
      data.stdout_tail = (proc.stdout ?? "").slice(-4000);
    }
    data.stderr_tail = (proc.stderr ?? "").slice(-2000);
    const ok = proc.returncode === 0;
    return toolResult({
      success: ok,
      data,
      error: ok ? null : `hyperframes add ${block} exit ${proc.returncode}`,
    });
  }

  private async render(inputs: Record<string, unknown>): Promise<ToolResult> {
    const runtimeOk = this.runtimeCheck();
    if (!runtimeOk.runtime_available) {
      return toolResult({
        success: false,
        error:
          "HyperFrames runtime not available: " +
          runtimeOk.reasons.join("; ") +
          ". Per governance, this is a blocker — do NOT silently " +
          "fall back to another runtime without user approval.",
        data: { runtime_check: runtimeOk },
      });
    }

    const workspace = HyperFramesCompose.requireWorkspace(inputs);
    const outputPath = path.resolve(
      (inputs.output_path as string) ??
        path.join(workspace, "renders", "final.mp4")
    );
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const steps: Record<string, any> = {};

    // 1. Scaffold.
    const scaffold = this.scaffold(inputs);
    steps.scaffold = scaffold.data;
    if (!scaffold.success) {
      return toolResult({
        success: false,
        error: `Scaffold failed: ${scaffold.error}`,
        data: { steps },
      });
    }

    // 2. Lint.
    const lint = await this.lint({ workspace_path: workspace });
    steps.lint = lint.data;
    if (!lint.success) {
      if (inputs.strict) {
        return toolResult({
          success: false,
          error: `Lint failed (strict mode): ${lint.error}`,
          data: { steps },
        });
      }
      console.warn(
        "hyperframes lint reported issues (non-strict mode, continuing)"
      );
    }

    // 3. Validate.
    const validate = await this.validate({
      workspace_path: workspace,
      skip_contrast: inputs.skip_contrast ?? false,
    });
    steps.validate = validate.data;
    if (!validate.success) {
      return toolResult({
        success: false,
        error:
          `Validate failed: ${validate.error}. HyperFrames render ` +
          `is blocked — fix the composition and re-run.`,
        data: { steps },
      });
    }

    // 4. Render.
    const [width, height, fps] = HyperFramesCompose.resolveDimensions(
      inputs.profile as string | undefined,
      (inputs.fps as number) ?? 30
    );
    const quality = (inputs.quality as string) ?? "standard";
    const args = [
      "render",
      "--output",
      outputPath,
      "--fps",
      String(fps),
      "--quality",
      quality,
    ];
    const proc = await this.runHf(args, { cwd: workspace, timeout: 1800 });
    steps.render = {
      exit_code: proc.returncode,
      stdout_tail: (proc.stdout ?? "").slice(-4000),
      stderr_tail: (proc.stderr ?? "").slice(-4000),
    };
    if (proc.returncode !== 0) {
      return toolResult({
        success: false,
        error: `hyperframes render exit ${proc.returncode}`,
        data: { steps },
      });
    }

    if (!fs.existsSync(outputPath)) {
      return toolResult({
        success: false,
        error:
          `hyperframes render exited 0 but output file missing: ` +
          `${outputPath}. Check stdout_tail for the real path.`,
        data: { steps },
      });
    }

    return toolResult({
      success: true,
      data: {
        operation: "render",
        output: outputPath,
        workspace,
        width,
        height,
        fps,
        quality,
        steps,
      },
      artifacts: [outputPath],
    });
  }

  // ------------------------------------------------------------------
  // Workspace generation helpers
  // ------------------------------------------------------------------
  private static requireWorkspace(inputs: Record<string, unknown>): string {
    const raw = inputs.workspace_path as string | undefined;
    if (!raw) {
      throw new Error("workspace_path is required for this operation");
    }
    return path.resolve(raw);
  }

  private static resolveDimensions(
    profileName: string | undefined,
    fpsIn: number
  ): [number, number, number] {
    if (profileName) {
      const p = MEDIA_PROFILES[profileName];
      if (p) return [p.width, p.height, p.fps];
    }
    return [1920, 1080, Math.trunc(fpsIn)];
  }

  private static computeTotalDuration(cuts: any[]): number {
    if (cuts.length === 0) return 0.0;
    return Math.max(...cuts.map((c) => Number(c.out_seconds ?? 0) || 0));
  }

  private resolveAndStageAssets(
    cuts: any[],
    assets: any[],
    workspace: string
  ): [any[], Array<{ from: string; to: string }>] {
    const assetLookup: Record<string, any> = {};
    for (const a of assets) {
      if ("id" in a) assetLookup[a.id] = a;
    }
    const assetsDir = path.join(workspace, "assets");
    const copies: Array<{ from: string; to: string }> = [];
    const resolved: any[] = [];
    for (const cut of cuts) {
      const source = cut.source ?? "";
      const resolvedCut = { ...cut };
      if (source in assetLookup) {
        resolvedCut.source = assetLookup[source].path ?? source;
      }
      const srcPath = resolvedCut.source
        ? String(resolvedCut.source)
        : null;
      if (
        srcPath &&
        fs.existsSync(srcPath) &&
        !HyperFramesCompose.isInside(srcPath, workspace)
      ) {
        const dest = path.join(assetsDir, path.basename(srcPath));
        if (
          !fs.existsSync(dest) ||
          fs.statSync(dest).size !== fs.statSync(srcPath).size
        ) {
          fs.copyFileSync(srcPath, dest);
        }
        resolvedCut.source = dest;
        copies.push({ from: srcPath, to: dest });
      }
      resolved.push(resolvedCut);
    }
    return [resolved, copies];
  }

  private resolveAudioRefs(
    audio: Record<string, any>,
    assets: any[],
    workspace: string
  ): Record<string, any> {
    const assetLookup: Record<string, any> = {};
    for (const a of assets) {
      if ("id" in a) assetLookup[a.id] = a;
    }
    const assetsDir = path.join(workspace, "assets");
    const out: Record<string, any> = { narration: [], music: null };

    const segments =
      (audio.narration as Record<string, any>)?.segments ?? [];
    for (const seg of segments ?? []) {
      const aid = seg.asset_id;
      if (!aid || !(aid in assetLookup)) continue;
      const src = String(assetLookup[aid].path ?? "");
      if (!fs.existsSync(src)) continue;
      let dest: string;
      if (!HyperFramesCompose.isInside(src, workspace)) {
        dest = path.join(assetsDir, path.basename(src));
        if (
          !fs.existsSync(dest) ||
          fs.statSync(dest).size !== fs.statSync(src).size
        ) {
          fs.copyFileSync(src, dest);
        }
      } else {
        dest = src;
      }
      const endSeconds = Number(seg.end_seconds ?? 0) || 0;
      out.narration.push({
        src: dest,
        start_seconds: Number(seg.start_seconds ?? 0) || 0,
        end_seconds: endSeconds || null,
      });
    }

    const music = (audio.music as Record<string, any>) ?? {};
    const mId = music.asset_id;
    if (mId && mId in assetLookup) {
      const src = String(assetLookup[mId].path ?? "");
      if (fs.existsSync(src)) {
        let dest: string;
        if (!HyperFramesCompose.isInside(src, workspace)) {
          dest = path.join(assetsDir, path.basename(src));
          if (
            !fs.existsSync(dest) ||
            fs.statSync(dest).size !== fs.statSync(src).size
          ) {
            fs.copyFileSync(src, dest);
          }
        } else {
          dest = src;
        }
        out.music = {
          src: dest,
          volume: Number(music.volume ?? 0.15) || 0.15,
          fade_in_seconds: Number(music.fade_in_seconds ?? 0) || 0,
          fade_out_seconds: Number(music.fade_out_seconds ?? 0) || 0,
        };
      }
    }

    return out;
  }

  private static isInside(p: string, root: string): boolean {
    const rel = path.relative(path.resolve(root), path.resolve(p));
    return !rel.startsWith("..") && !path.isAbsolute(rel);
  }

  /**
   * Bridge Montagent playbook → HyperFrames CSS vars + DESIGN.md. The Python
   * delegates to lib.hyperframes_style_bridge with a built-in fallback; that
   * module has no TS port, so we use the fallback directly (same output).
   */
  private styleBridge(
    playbook: Record<string, any>,
    _editDecisions: Record<string, any>
  ): [Record<string, string>, string] {
    const vl = (playbook ?? {}).visual_language ?? {};
    const palette = (vl as Record<string, any>).color_palette ?? {};
    const typo = (playbook ?? {}).typography ?? {};

    const first = (raw: any, def: string): string => {
      if (Array.isArray(raw) && raw.length > 0) return String(raw[0]);
      if (typeof raw === "string" && raw) return raw;
      return def;
    };

    const bg = first(palette.background, "#0B0F1A");
    const fg = first(palette.text, "#F5F5F5");
    const accent = first(palette.accent, "#F59E0B");
    const primary = first(palette.primary, "#2563EB");
    const heading =
      (typo.heading as Record<string, any>)?.font ??
      (typo.heading as Record<string, any>)?.family ??
      "Inter";
    const body =
      (typo.body as Record<string, any>)?.font ??
      (typo.body as Record<string, any>)?.family ??
      "Inter";

    const cssVars: Record<string, string> = {
      "--color-bg": bg,
      "--color-fg": fg,
      "--color-accent": accent,
      "--color-primary": primary,
      "--font-heading": heading,
      "--font-body": body,
      "--ease-primary": "cubic-bezier(0.65, 0, 0.35, 1)",
      "--duration-entrance": "0.6s",
    };
    const designMd =
      "# DESIGN\n\n" +
      "Generated by Montagent HyperFrames style bridge (fallback).\n\n" +
      `- Background: \`${bg}\`\n` +
      `- Foreground: \`${fg}\`\n` +
      `- Accent: \`${accent}\`\n` +
      `- Primary: \`${primary}\`\n` +
      `- Heading font: \`${heading}\`\n` +
      `- Body font: \`${body}\`\n`;
    return [cssVars, designMd];
  }

  // ------------------------------------------------------------------
  // HTML generation (minimal, Phase 1)
  // ------------------------------------------------------------------
  private generateIndexHtml(args: {
    cuts: any[];
    audioRefs: Record<string, any>;
    width: number;
    height: number;
    totalDuration: number;
    cssVars: Record<string, string>;
    title: string;
  }): string {
    const { cuts, audioRefs, width, height, totalDuration, cssVars, title } =
      args;
    const varsCss = Object.entries(cssVars)
      .map(([k, v]) => `${k}: ${v};`)
      .join("\n      ");

    const clipHtml: string[] = [];
    const entranceTweens: string[] = [];
    for (let i = 0; i < cuts.length; i++) {
      const [html, tween] = this.cutToHtml(i, cuts[i], width, height);
      clipHtml.push(html);
      if (tween) entranceTweens.push(tween);
    }

    const audioHtml: string[] = [];
    const narration = (audioRefs.narration as any[]) ?? [];
    for (let j = 0; j < narration.length; j++) {
      const nar = narration[j];
      const src = HyperFramesCompose.relFromWorkspace(nar.src);
      const start = nar.start_seconds ?? 0;
      const end = nar.end_seconds;
      const duration =
        end && end > start ? end - start : totalDuration - start;
      audioHtml.push(
        `<audio id="nar-${j}" ` +
          `data-start="${HyperFramesCompose.f(start)}" data-duration="${HyperFramesCompose.f(duration)}" ` +
          `data-track-index="2" src="${HyperFramesCompose.escapeAttr(src)}" ` +
          `data-volume="1"></audio>`
      );
    }

    const music = audioRefs.music;
    if (music) {
      const src = HyperFramesCompose.relFromWorkspace(music.src);
      audioHtml.push(
        `<audio id="music" ` +
          `data-start="0" data-duration="${HyperFramesCompose.f(totalDuration)}" ` +
          `data-track-index="3" src="${HyperFramesCompose.escapeAttr(src)}" ` +
          `data-volume="${HyperFramesCompose.f(music.volume)}"></audio>`
      );
    }

    const tweenBlock =
      entranceTweens.length > 0
        ? entranceTweens.join("\n        ")
        : "// no tweens";

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${HyperFramesCompose.escapeText(title)}</title>
  <style>
    :root {
      ${varsCss}
    }
    body { margin: 0; background: var(--color-bg); color: var(--color-fg); font-family: var(--font-body); }
    [data-composition-id="root"] {
      position: relative;
      width: ${width}px;
      height: ${height}px;
      overflow: hidden;
    }
    .clip { position: absolute; inset: 0; }
    .clip.video-clip, .clip.image-clip { object-fit: cover; width: 100%; height: 100%; }
    .clip.text-card { display: flex; align-items: center; justify-content: center; padding: 120px 160px; box-sizing: border-box; text-align: center; }
    .clip.text-card h1 { font-family: var(--font-heading); font-weight: 700; font-size: 96px; line-height: 1.1; margin: 0; color: var(--color-fg); }
    .clip.text-card .subtitle { font-size: 36px; margin-top: 24px; color: var(--color-accent); }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
</head>
<body>
  <div data-composition-id="root" data-start="0" data-duration="${HyperFramesCompose.f(totalDuration)}" data-width="${width}" data-height="${height}">
    ${clipHtml.join("")}
    ${audioHtml.join("")}
    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      ${tweenBlock}
      window.__timelines["root"] = tl;
    </script>
  </div>
</body>
</html>
`;
  }

  private cutToHtml(
    index: number,
    cut: Record<string, any>,
    width: number,
    height: number
  ): [string, string | null] {
    const cutId = `cut-${index}`;
    const inS = Number(cut.in_seconds ?? 0) || 0;
    const outS = Number(cut.out_seconds ?? 0) || 0;
    const duration = Math.max(0.1, outS - inS);

    const source = cut.source ?? "";
    const cutType = String(cut.type ?? "").toLowerCase();
    const text = cut.text ?? cut.title ?? "";

    const ext = source ? path.extname(String(source)).toLowerCase() : "";

    // Text card / hero title / callout, or text-only cut.
    if (
      ["text_card", "hero_title", "callout"].includes(cutType) ||
      (!source && text)
    ) {
      let inner = `<h1>${HyperFramesCompose.escapeText(text || `Scene ${index + 1}`)}</h1>`;
      const subtitle = cut.subtitle ?? cut.caption;
      if (subtitle) {
        inner += `<div class="subtitle">${HyperFramesCompose.escapeText(subtitle)}</div>`;
      }
      const html =
        `<div id="${cutId}" class="clip text-card" ` +
        `data-start="${HyperFramesCompose.f(inS)}" data-duration="${HyperFramesCompose.f(duration)}" ` +
        `data-track-index="1">${inner}</div>`;
      const tween =
        `tl.from("#${cutId} h1", { y: 40, opacity: 0, duration: 0.6, ` +
        `ease: "power3.out" }, ${HyperFramesCompose.f(inS + 0.1)});`;
      return [html, tween];
    }

    if (IMAGE_EXTENSIONS.has(ext) && source) {
      const rel = HyperFramesCompose.relFromWorkspace(String(source));
      const html =
        `<img id="${cutId}" class="clip image-clip" ` +
        `src="${HyperFramesCompose.escapeAttr(rel)}" ` +
        `data-start="${HyperFramesCompose.f(inS)}" data-duration="${HyperFramesCompose.f(duration)}" ` +
        `data-track-index="1" alt="">`;
      const tween =
        `tl.from("#${cutId}", { scale: 1.05, opacity: 0, duration: 0.5, ` +
        `ease: "power2.out" }, ${HyperFramesCompose.f(inS)});`;
      return [html, tween];
    }

    if (VIDEO_EXTENSIONS.has(ext) && source) {
      const rel = HyperFramesCompose.relFromWorkspace(String(source));
      const html =
        `<video id="${cutId}" class="clip video-clip" ` +
        `src="${HyperFramesCompose.escapeAttr(rel)}" ` +
        `data-start="${HyperFramesCompose.f(inS)}" data-duration="${HyperFramesCompose.f(duration)}" ` +
        `data-track-index="1" muted playsinline></video>`;
      return [html, null];
    }

    // HTML composition reference.
    if ([".html", ".htm"].includes(ext) && source) {
      const rel = HyperFramesCompose.relFromWorkspace(String(source));
      const compositionId = path.basename(rel, path.extname(rel));
      const html =
        `<div id="${cutId}" class="clip composition-clip" ` +
        `data-composition-id="${HyperFramesCompose.escapeAttr(compositionId)}" ` +
        `data-composition-src="${HyperFramesCompose.escapeAttr(rel)}" ` +
        `data-start="${HyperFramesCompose.f(inS)}" data-duration="${HyperFramesCompose.f(duration)}" ` +
        `data-width="${width}" data-height="${height}" ` +
        `data-track-index="1"></div>`;
      return [html, null];
    }

    // Unknown cut shape — placeholder text card.
    const placeholder = HyperFramesCompose.escapeText(
      text || cut.reason || `Scene ${index + 1}`
    );
    const html =
      `<div id="${cutId}" class="clip text-card" ` +
      `data-start="${HyperFramesCompose.f(inS)}" data-duration="${HyperFramesCompose.f(duration)}" ` +
      `data-track-index="1"><h1>${placeholder}</h1></div>`;
    return [html, null];
  }

  // ------------------------------------------------------------------
  // Utilities
  // ------------------------------------------------------------------

  /**
   * Invoke `npx --yes hyperframes <args>`. We do NOT raise on non-zero exit —
   * the caller parses lint/validate/render exit codes itself (execa reject:false).
   * Timeouts surface as returncode 124 with a note in stderr.
   */
  private async runHf(
    args: string[],
    opts: { cwd: string | null; timeout: number }
  ): Promise<ProcResult> {
    const cmd = ["npx", "--yes", "hyperframes", ...args];
    try {
      const proc = await execa(cmd[0], cmd.slice(1), {
        timeout: opts.timeout * 1000,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        reject: false,
        all: false,
      });
      if (proc.timedOut) {
        return {
          returncode: 124,
          stdout: String(proc.stdout ?? ""),
          stderr: String(proc.stderr ?? "") + `\n[timeout after ${opts.timeout}s]`,
        };
      }
      return {
        returncode: proc.exitCode ?? 0,
        stdout: String(proc.stdout ?? ""),
        stderr: String(proc.stderr ?? ""),
      };
    } catch (e: any) {
      // execa with reject:false generally won't throw, but ENOENT (npx missing)
      // still rejects — surface it as a failed CompletedProcess-shaped result.
      if (e && e.timedOut) {
        return {
          returncode: 124,
          stdout: String(e.stdout ?? ""),
          stderr: String(e.stderr ?? "") + `\n[timeout after ${opts.timeout}s]`,
        };
      }
      return {
        returncode: typeof e?.exitCode === "number" ? e.exitCode : 127,
        stdout: String(e?.stdout ?? ""),
        stderr: String(e?.stderr ?? e?.shortMessage ?? errMsg(e)),
      };
    }
  }

  /** Parse a `--json` report, tolerating surrounding banner lines. */
  private static parseJsonOutput(stdout: string): unknown {
    if (!stdout) return null;
    const start = stdout.indexOf("{");
    const end = stdout.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(stdout.slice(start, end + 1));
    } catch {
      return null;
    }
  }

  private static f(v: number): string {
    let s = Number(v).toFixed(3);
    // Strip trailing zeros, then a trailing dot (matches Python rstrip logic).
    s = s.replace(/0+$/, "").replace(/\.$/, "");
    return s;
  }

  private static escapeText(s: string): string {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  private static escapeAttr(s: string): string {
    return HyperFramesCompose.escapeText(s).replace(/"/g, "&quot;");
  }

  /**
   * HyperFrames resolves src= relative to index.html. Staged assets live under
   * workspace/assets/, so an absolute path is rewritten to its anchor-relative
   * form (assets/<...> or compositions/<...>), else just `assets/<name>`.
   */
  private static relFromWorkspace(p: string): string {
    if (!path.isAbsolute(p)) {
      return p.replace(/\\/g, "/");
    }
    const parts = p.split(path.sep).filter(Boolean);
    for (const anchor of ["assets", "compositions"]) {
      const idx = parts.lastIndexOf(anchor);
      if (idx !== -1) {
        return parts.slice(idx).join("/");
      }
    }
    return `assets/${path.basename(p)}`;
  }
}

// ---------------------------------------------------------------------------
// Module-local helpers
// ---------------------------------------------------------------------------
function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Synchronous subprocess helper for the runtime check (node --version,
 * npm view). Wraps execa's execaSync to a uniform shape; reject:false keeps a
 * non-zero exit / timeout from throwing past the caller.
 */
function runSync(
  bin: string,
  args: string[],
  timeoutMs: number
): { exitCode: number; stdout: string; stderr: string; timedOut?: boolean } {
  const proc = execaSync(bin, args, { timeout: timeoutMs, reject: false }) as {
    exitCode?: number;
    stdout?: unknown;
    stderr?: unknown;
    timedOut?: boolean;
  };
  return {
    exitCode: proc.exitCode ?? 0,
    stdout: String(proc.stdout ?? ""),
    stderr: String(proc.stderr ?? ""),
    timedOut: proc.timedOut,
  };
}
