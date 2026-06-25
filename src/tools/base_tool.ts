/**
 * Base tool class implementing the Montagent ToolContract (TypeScript port).
 *
 * 1:1 port of tools/base_tool.py. Every tool inherits from BaseTool, which
 * enforces a uniform interface for discovery, execution, cost estimation, and
 * health reporting.
 *
 * Parity notes vs. Python:
 *  - Field names are kept snake_case so getInfo() output and registry attribute
 *    access match the Python contract verbatim (preflight JSON must be equivalent).
 *  - ToolRuntime.LOCAL_GPU is intentionally REMOVED (no local GPU/PyTorch in the TS port).
 *  - Dependency prefixes are "env:" and "cmd:" only; "python:" is dropped with PyTorch.
 *  - Only execute() is async (per the async-first convention); getStatus/getInfo stay sync.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa, type Options as ExecaOptions } from "execa";
import dotenv from "dotenv";

// ---------------------------------------------------------------------------
// Load .env once at import time (matches Python _load_dotenv: never overrides
// an already-set variable). Located at the project root (two levels above this
// file: src/tools/base_tool.ts -> <root>/.env).
// ---------------------------------------------------------------------------
const _here = path.dirname(fileURLToPath(import.meta.url));
const _projectRoot = path.resolve(_here, "..", "..");
dotenv.config({ path: path.join(_projectRoot, ".env") }); // dotenv does not override existing env vars
export const PROJECT_ROOT = _projectRoot;

// ---------------------------------------------------------------------------
// Enums (string enums so the member value IS the wire string, matching .value)
// ---------------------------------------------------------------------------
export enum ToolTier {
  CORE = "core",
  VOICE = "voice",
  ENHANCE = "enhance",
  GENERATE = "generate",
  SOURCE = "source",
  ANALYZE = "analyze",
  PUBLISH = "publish",
}

export enum ToolStability {
  EXPERIMENTAL = "experimental",
  BETA = "beta",
  PRODUCTION = "production",
}

export enum ToolStatus {
  AVAILABLE = "available",
  UNAVAILABLE = "unavailable",
  DEGRADED = "degraded",
}

/** Where and how a tool executes. NOTE: LOCAL_GPU removed in the TS port. */
export enum ToolRuntime {
  LOCAL = "local", // Runs entirely on-device, free, no network
  API = "api", // Calls an external API, requires API key, costs money
  HYBRID = "hybrid", // Can run locally OR via API (e.g. image_selector)
}

export enum ExecutionMode {
  SYNC = "sync",
  ASYNC = "async",
}

export enum Determinism {
  DETERMINISTIC = "deterministic",
  SEEDED = "seeded",
  STOCHASTIC = "stochastic",
}

export enum ResumeSupport {
  NONE = "none",
  FROM_START = "from_start",
  FROM_CHECKPOINT = "from_checkpoint",
}

// ---------------------------------------------------------------------------
// Value objects
// ---------------------------------------------------------------------------
export interface ResourceProfile {
  cpu_cores: number;
  ram_mb: number;
  vram_mb: number;
  disk_mb: number;
  network_required: boolean;
}

export const defaultResourceProfile = (): ResourceProfile => ({
  cpu_cores: 1,
  ram_mb: 512,
  vram_mb: 0,
  disk_mb: 100,
  network_required: false,
});

export interface RetryPolicy {
  max_retries: number;
  backoff_seconds: number;
  retryable_errors: string[];
}

export const defaultRetryPolicy = (): RetryPolicy => ({
  max_retries: 0,
  backoff_seconds: 1.0,
  retryable_errors: [],
});

/** Standard result returned by tool execution (mirrors the Python dataclass). */
export interface ToolResult {
  success: boolean;
  data?: Record<string, unknown>;
  artifacts?: string[];
  error?: string | null;
  cost_usd?: number;
  duration_seconds?: number;
  seed?: number | null;
  model?: string | null;
}

/** Construct a ToolResult with the same defaults as the Python dataclass. */
export function toolResult(partial: Partial<ToolResult> & { success: boolean }): ToolResult {
  return {
    data: {},
    artifacts: [],
    error: null,
    cost_usd: 0,
    duration_seconds: 0,
    seed: null,
    model: null,
    ...partial,
  };
}

export class DependencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DependencyError";
  }
}

// ---------------------------------------------------------------------------
// PATH lookup (sync, no subprocess) — equivalent of shutil.which for cmd: deps.
// ---------------------------------------------------------------------------
export function commandExists(cmd: string): boolean {
  if (path.isAbsolute(cmd)) {
    try {
      fs.accessSync(cmd, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        return true;
      } catch {
        /* keep scanning */
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// BaseTool
// ---------------------------------------------------------------------------
export abstract class BaseTool {
  // --- Identity (override in subclasses) ---
  name = "";
  version = "0.1.0";
  tier: ToolTier = ToolTier.CORE;
  stability: ToolStability = ToolStability.EXPERIMENTAL;
  execution_mode: ExecutionMode = ExecutionMode.SYNC;
  determinism: Determinism = Determinism.DETERMINISTIC;
  runtime: ToolRuntime = ToolRuntime.LOCAL;

  // --- Dependencies ---
  // For API tools, add "env:ENVVAR_NAME"; for binaries, "cmd:ffmpeg".
  dependencies: string[] = [];
  install_instructions = "";

  // --- Capabilities ---
  capability = "generic";
  provider = "montagent";
  capabilities: string[] = [];
  input_schema: Record<string, unknown> = {};
  output_schema: Record<string, unknown> = {};
  artifact_schema: Record<string, unknown> = {};
  progress_schema: Record<string, unknown> | null = null;
  supports: Record<string, unknown> = {};
  best_for: string[] = [];
  not_good_for: string[] = [];
  provider_matrix: Record<string, unknown> = {};

  // --- Resource & retry ---
  resource_profile: ResourceProfile = defaultResourceProfile();
  retry_policy: RetryPolicy = defaultRetryPolicy();

  // --- Resume & idempotency ---
  resume_support: ResumeSupport = ResumeSupport.NONE;
  idempotency_key_fields: string[] = [];

  // --- Side effects & fallback ---
  side_effects: string[] = [];
  fallback: string | null = null;
  fallback_tools: string[] = [];

  // --- Agent skills (Layer 3 references) ---
  agent_skills: string[] = [];

  // --- Verification ---
  user_visible_verification: string[] = [];

  // --- Optional telemetry / quality hints ---
  quality_score: number | null = null;
  historical_success_rate: number | null = null;
  latency_p50_seconds: number | null = null;

  // Optional: tools may set this to point at their source file for discovery.
  usage_location = "";

  // ---- Status reporting ----

  getStatus(): ToolStatus {
    try {
      this.checkDependencies();
      return ToolStatus.AVAILABLE;
    } catch (err) {
      if (err instanceof DependencyError) return ToolStatus.UNAVAILABLE;
      throw err;
    }
  }

  /** Verify all dependencies are installed. Throws DependencyError if not. */
  checkDependencies(): void {
    for (const dep of this.dependencies) {
      if (dep.startsWith("cmd:")) {
        const cmdName = dep.slice(4);
        if (!commandExists(cmdName)) {
          throw new DependencyError(
            `Command '${cmdName}' not found. ${this.install_instructions}`
          );
        }
      } else if (dep.startsWith("env:")) {
        const envName = dep.slice(4);
        if (!process.env[envName]) {
          throw new DependencyError(
            `Environment variable '${envName}' not set. ${this.install_instructions}`
          );
        }
      }
      // "python:" prefix intentionally unsupported (dropped with PyTorch).
    }
  }

  /** Hook for subclasses to add capability-specific info (e.g. render_engines). */
  protected extraInfo(): Record<string, unknown> {
    return {};
  }

  /** Full tool contract info for registry/discovery (keys match Python get_info). */
  getInfo(): Record<string, unknown> {
    return {
      name: this.name,
      version: this.version,
      tier: this.tier,
      capability: this.capability,
      provider: this.provider,
      stability: this.stability,
      status: this.getStatus(),
      execution_mode: this.execution_mode,
      determinism: this.determinism,
      runtime: this.runtime,
      module_path: this.constructor.name,
      usage_location: this.usage_location,
      dependencies: this.dependencies,
      install_instructions: this.install_instructions,
      capabilities: this.capabilities,
      input_schema: this.input_schema,
      output_schema: this.output_schema,
      artifact_schema: this.artifact_schema,
      supports: this.supports,
      best_for: this.best_for,
      not_good_for: this.not_good_for,
      provider_matrix: this.provider_matrix,
      resource_profile: { ...this.resource_profile },
      resume_support: this.resume_support,
      side_effects: this.side_effects,
      fallback: this.fallback,
      fallback_tools:
        this.fallback_tools.length > 0
          ? this.fallback_tools
          : this.fallback
            ? [this.fallback]
            : [],
      agent_skills: this.agent_skills,
      related_skills: this.agent_skills,
      user_visible_verification: this.user_visible_verification,
      quality_score: this.quality_score,
      historical_success_rate: this.historical_success_rate,
      latency_p50_seconds: this.latency_p50_seconds,
      ...this.extraInfo(),
    };
  }

  // ---- Cost / runtime estimation (override for paid/long tools) ----
  estimateCost(_inputs: Record<string, unknown>): number {
    return 0.0;
  }

  estimateRuntime(_inputs: Record<string, unknown>): number {
    return 0.0;
  }

  // ---- Execution ----
  abstract execute(inputs: Record<string, unknown>): Promise<ToolResult>;

  dryRun(inputs: Record<string, unknown>): Record<string, unknown> {
    return {
      tool: this.name,
      estimated_cost_usd: this.estimateCost(inputs),
      estimated_runtime_seconds: this.estimateRuntime(inputs),
      status: this.getStatus(),
      would_execute: true,
    };
  }

  // ---- CLI helper ----
  /**
   * Run a subprocess command with standard error handling.
   * execa natively resolves Windows .cmd/.bat wrappers (e.g. npx, npm),
   * replacing the hand-rolled shutil.which logic in the Python version.
   */
  protected runCommand(
    cmd: string[],
    opts?: { timeout?: number; cwd?: string }
  ) {
    const [bin, ...args] = cmd;
    const execaOpts: ExecaOptions = {
      ...(opts?.timeout !== undefined ? { timeout: opts.timeout } : {}),
      ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
    };
    return execa(bin as string, args, execaOpts);
  }
}
