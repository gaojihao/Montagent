/**
 * Runtime configuration model for Montagent
 * (port of lib/config_model.py from Pydantic to zod).
 *
 * Loads config.yaml, validates it, and provides typed access. The zod schema
 * mirrors the Pydantic model field-for-field (same field names, defaults,
 * required/optional). No GPU/PyTorch-specific fields exist in this config, so
 * nothing is dropped.
 *
 * Parity notes vs. Python:
 *  - BudgetMode / CheckpointPolicy are string enums whose values match Pydantic.
 *  - MontagentConfig.load() → loadConfig(): falls back to defaults when the
 *    file is missing (Python returns cls()).
 *  - resolve_path() → resolvePath(): resolves a PathsConfig key against the
 *    project root (defaults to PROJECT_ROOT).
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import YAML from "yaml";

import { PROJECT_ROOT } from "../tools/base_tool.js";

export enum BudgetMode {
  OBSERVE = "observe",
  WARN = "warn",
  CAP = "cap",
}

export enum CheckpointPolicy {
  GUIDED = "guided",
  MANUAL_ALL = "manual_all",
  AUTO_NONCREATIVE = "auto_noncreative",
}

// ---------------------------------------------------------------------------
// Sub-models (each mirrors a Pydantic BaseModel; defaults match field-for-field)
// ---------------------------------------------------------------------------
export const LLMConfigSchema = z
  .object({
    provider: z.string().default("anthropic"),
    model: z.string().nullable().default(null),
    temperature: z.number().default(0.7),
    max_tokens: z.number().int().default(4096),
  })
  .default({});

export const BudgetConfigSchema = z
  .object({
    mode: z.nativeEnum(BudgetMode).default(BudgetMode.WARN),
    total_usd: z.number().default(10.0),
    reserve_pct: z.number().default(0.1),
    single_action_approval_usd: z.number().default(0.5),
    require_approval_for_new_paid_tool: z.boolean().default(true),
  })
  .default({});

export const CheckpointConfigSchema = z
  .object({
    policy: z.nativeEnum(CheckpointPolicy).default(CheckpointPolicy.GUIDED),
    storage_dir: z.string().default("pipeline"),
  })
  .default({});

export const OutputConfigSchema = z
  .object({
    default_format: z.string().default("mp4"),
    default_codec: z.string().default("libx264"),
    default_audio_codec: z.string().default("aac"),
    default_resolution: z.string().default("1920x1080"),
    default_fps: z.number().int().default(30),
    default_crf: z.number().int().default(23),
  })
  .default({});

export const PathsConfigSchema = z
  .object({
    pipeline_dir: z.string().default("pipeline"),
    library_dir: z.string().default("library"),
    styles_dir: z.string().default("styles"),
    skills_dir: z.string().default("skills"),
    output_dir: z.string().default("output"),
  })
  .default({});

// ---------------------------------------------------------------------------
// Top-level config
// ---------------------------------------------------------------------------
export const MontagentConfigSchema = z
  .object({
    llm: LLMConfigSchema,
    budget: BudgetConfigSchema,
    checkpoint: CheckpointConfigSchema,
    output: OutputConfigSchema,
    paths: PathsConfigSchema,
  })
  .default({});

export type LLMConfig = z.infer<typeof LLMConfigSchema>;
export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;
export type CheckpointConfig = z.infer<typeof CheckpointConfigSchema>;
export type OutputConfig = z.infer<typeof OutputConfigSchema>;
export type PathsConfig = z.infer<typeof PathsConfigSchema>;
export type MontagentConfig = z.infer<typeof MontagentConfigSchema>;

/** Build a fully-defaulted config (mirrors `MontagentConfig()` in Python). */
export function defaultConfig(): MontagentConfig {
  return MontagentConfigSchema.parse({});
}

const DEFAULT_CONFIG_PATH = path.join(PROJECT_ROOT, "config.yaml");

/**
 * Load config from a YAML file, validating against the zod schema.
 * Falls back to defaults if the file is missing (mirrors Python load()).
 *
 * @throws ZodError if the file exists but fails validation.
 */
export function loadConfig(configPath: string = DEFAULT_CONFIG_PATH): MontagentConfig {
  if (fs.existsSync(configPath)) {
    const raw = (YAML.parse(fs.readFileSync(configPath, "utf-8")) ?? {}) as unknown;
    return MontagentConfigSchema.parse(raw);
  }
  return defaultConfig();
}

/**
 * Resolve a relative path from PathsConfig against the project root.
 * Mirrors Python MontagentConfig.resolve_path.
 */
export function resolvePath(
  config: MontagentConfig,
  key: keyof PathsConfig,
  projectRoot: string = PROJECT_ROOT,
): string {
  const value = config.paths[key];
  return path.resolve(projectRoot, value);
}
