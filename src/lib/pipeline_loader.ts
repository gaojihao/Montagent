/**
 * Pipeline manifest loader (1:1 port of lib/pipeline_loader.py).
 *
 * Loads and validates pipeline YAML manifests from pipeline_defs/, and exposes
 * the same query helpers the Python module exposes (stage order, sub-stages,
 * required tools, skills, review focus, reference-input config, and capability
 * extension enforcement).
 *
 * Parity notes vs. Python:
 *  - Validates against schemas/pipelines/pipeline_manifest.schema.json via the
 *    shared ajv instance (same schema file as Python's jsonschema).
 *  - get_required_tools returns a Python `set`; here it returns a JS `Set<string>`.
 *  - Function names mirror the Python snake_case helpers in camelCase.
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import { PROJECT_ROOT } from "../tools/base_tool.js";
import { SCHEMA_ROOT, getValidator, formatErrors } from "./schema_validator.js";

export const PIPELINE_DEFS_DIR = path.join(PROJECT_ROOT, "pipeline_defs");
const SCHEMA_PATH = path.join(SCHEMA_ROOT, "pipelines", "pipeline_manifest.schema.json");

export type PipelineManifest = Record<string, any>;
export type StageDef = Record<string, any>;
export type SubStageDef = Record<string, any>;

/**
 * Load and validate a pipeline manifest by name.
 *
 * @param name Pipeline name (without .yaml extension).
 * @param defsDir Override directory for pipeline definitions.
 * @returns Validated pipeline manifest object.
 * @throws if the manifest file is missing or fails schema validation.
 */
export function loadPipeline(name: string, defsDir: string = PIPELINE_DEFS_DIR): PipelineManifest {
  const filePath = path.join(defsDir, `${name}.yaml`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Pipeline manifest not found: ${filePath}`);
  }

  const manifest = YAML.parse(fs.readFileSync(filePath, "utf-8")) as PipelineManifest;

  const validate = getValidator(SCHEMA_PATH);
  if (!validate(manifest)) {
    throw new Error(`Pipeline manifest '${name}' failed schema validation: ${formatErrors(validate)}`);
  }

  return manifest;
}

/** List all available pipeline manifest names. */
export function listPipelines(defsDir: string = PIPELINE_DEFS_DIR): string[] {
  return fs
    .readdirSync(defsDir)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => f.replace(/\.yaml$/, ""));
}

/** Evaluate a simple manifest condition against runtime context. */
function conditionIsActive(
  condition: string | null | undefined,
  context: Record<string, any> | null | undefined,
): boolean {
  if (!condition) return true;
  if (!context) return false;
  return Boolean(context[condition]);
}

/** Return reference-input configuration, defaulting to disabled. */
export function getReferenceInputConfig(manifest: PipelineManifest): Record<string, any> {
  return manifest.reference_input ?? {};
}

/** Whether the manifest declares support for reference-video input. */
export function pipelineSupportsReferenceInput(manifest: PipelineManifest): boolean {
  return Boolean(getReferenceInputConfig(manifest).supported ?? false);
}

/**
 * Return sub-stage definitions for a stage.
 *
 * By default returns all declared sub-stages. Pass `includeInactive=false`
 * with context to filter to active sub-stages only.
 */
export function getStageSubStages(
  manifest: PipelineManifest,
  stageName: string,
  opts: { context?: Record<string, any> | null; includeInactive?: boolean } = {},
): SubStageDef[] {
  const { context = null, includeInactive = true } = opts;
  for (const stage of manifest.stages as StageDef[]) {
    if (stage.name !== stageName) continue;
    const subStages: SubStageDef[] = [...(stage.sub_stages ?? [])];
    if (includeInactive) return subStages;
    return subStages.filter((s) => conditionIsActive(s.condition, context));
  }
  return [];
}

/**
 * Extract the ordered list of stage names from a manifest.
 *
 * `includeSubStages=true` emits declarative sub-stages as `<stage>.<sub_stage>`.
 */
export function getStageOrder(
  manifest: PipelineManifest,
  opts: { includeSubStages?: boolean; context?: Record<string, any> | null } = {},
): string[] {
  const { includeSubStages = false, context = null } = opts;
  const order: string[] = [];
  for (const stage of manifest.stages as StageDef[]) {
    order.push(stage.name);
    if (!includeSubStages) continue;
    for (const subStage of getStageSubStages(manifest, stage.name, {
      context,
      includeInactive: context === null,
    })) {
      order.push(`${stage.name}.${subStage.name}`);
    }
  }
  return order;
}

/** Collect tools across stages, sub-stages, and reference-input analysis. */
export function getRequiredTools(manifest: PipelineManifest): Set<string> {
  const tools = new Set<string>();
  for (const stage of manifest.stages as StageDef[]) {
    for (const t of stage.preferred_tools ?? []) tools.add(t);
    for (const t of stage.fallback_tools ?? []) tools.add(t);
    for (const t of stage.tools_available ?? []) tools.add(t);
    for (const subStage of stage.sub_stages ?? []) {
      for (const t of subStage.tools_available ?? []) tools.add(t);
    }
  }
  for (const t of getReferenceInputConfig(manifest).analysis_tools ?? []) tools.add(t);
  return tools;
}

/** Get the skill path for an instruction-driven stage (or null). */
export function getStageSkill(manifest: PipelineManifest, stageName: string): string | null {
  for (const stage of manifest.stages as StageDef[]) {
    if (stage.name === stageName) return stage.skill ?? null;
  }
  return null;
}

/** Get the review focus items for a stage. */
export function getStageReviewFocus(manifest: PipelineManifest, stageName: string): string[] {
  for (const stage of manifest.stages as StageDef[]) {
    if (stage.name === stageName) return stage.review_focus ?? [];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Capability-Extension Enforcement
// ---------------------------------------------------------------------------

/** Raised when a capability extension is used but not permitted by the pipeline. */
export class ExtensionNotPermitted extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionNotPermitted";
  }
}

const VALID_EXTENSIONS = ["custom_scripts", "custom_playbooks", "custom_skills", "custom_tools"] as const;
export type ExtensionType = (typeof VALID_EXTENSIONS)[number];

/**
 * Enforce that a capability extension is permitted by the pipeline manifest.
 *
 * @throws ExtensionNotPermitted if the extension is not allowed.
 * @throws Error for an unknown extension type.
 */
export function checkExtensionPermitted(manifest: PipelineManifest, extensionType: string): void {
  if (!(VALID_EXTENSIONS as readonly string[]).includes(extensionType)) {
    throw new Error(
      `Unknown extension type '${extensionType}'. Valid types: ${[...VALID_EXTENSIONS].sort().join(", ")}`,
    );
  }
  const extensions = manifest.extensions ?? {};
  if (!extensions[extensionType]) {
    throw new ExtensionNotPermitted(
      `Pipeline '${manifest.name ?? "unknown"}' does not permit ${extensionType}. ` +
        `Set extensions.${extensionType}: true in the pipeline manifest to allow this.`,
    );
  }
}

/** Return the extension permission flags for a pipeline. */
export function getPermittedExtensions(manifest: PipelineManifest): Record<ExtensionType, boolean> {
  const extensions = manifest.extensions ?? {};
  const result = {} as Record<ExtensionType, boolean>;
  for (const key of VALID_EXTENSIONS) {
    result[key] = Boolean(extensions[key] ?? false);
  }
  return result;
}
