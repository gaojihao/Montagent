/**
 * Shared ajv instance + schema loading/validation utilities.
 *
 * 1:1 port of the validation behavior in `schemas/artifacts/__init__.py`
 * (ARTIFACT_NAMES, load_schema, validate_artifact, list_schemas) plus a single
 * shared Ajv2020 instance reused by checkpoint/pipeline/playbook loaders.
 *
 * Parity notes vs. Python (jsonschema):
 *  - The SAME JSON Schema files under `schemas/` validate the SAME artifacts.
 *  - All 24 schemas declare draft 2020-12 ($schema), so we use Ajv2020.
 *  - `format: "date-time"` (checkpoint timestamps) requires ajv-formats.
 *  - Compiled validators are cached by schema path/name (like Python's bare
 *    module-level loads, but memoized for speed; behavior is identical).
 */
import fs from "node:fs";
import path from "node:path";
import * as ajvModule from "ajv/dist/2020.js";
import type { ValidateFunction, Options } from "ajv/dist/2020.js";
import * as ajvFormatsModule from "ajv-formats";

import { PROJECT_ROOT } from "../tools/base_tool.js";

export type { ValidateFunction };

// ajv + ajv-formats ship as CJS with `export default`; under NodeNext the
// default import binding is typed as the module namespace, which TS refuses to
// `new`/call. We only use Ajv#compile and ajv-formats as a plugin, so we model
// just those surfaces and resolve the real runtime values from the namespace
// (`.default`, falling back to the named `Ajv2020` export).
interface AjvInstance {
  compile(schema: unknown): ValidateFunction;
}
type AjvCtor = new (opts?: Options) => AjvInstance;
type AddFormats = (ajv: AjvInstance) => unknown;

const ajvNs = ajvModule as unknown as { default?: AjvCtor; Ajv2020?: AjvCtor };
const Ajv2020: AjvCtor = (ajvNs.default ?? ajvNs.Ajv2020) as AjvCtor;
const fmtNs = ajvFormatsModule as unknown as { default?: AddFormats };
const addFormats: AddFormats = (fmtNs.default ?? (ajvFormatsModule as unknown as AddFormats)) as AddFormats;

// Root of the reused JSON Schema assets (copied verbatim from the Python repo).
export const SCHEMA_ROOT = path.join(PROJECT_ROOT, "schemas");
const ARTIFACT_SCHEMA_DIR = path.join(SCHEMA_ROOT, "artifacts");

/**
 * Ordered list of canonical artifact names that carry a JSON Schema.
 * Mirrors ARTIFACT_NAMES in schemas/artifacts/__init__.py verbatim.
 */
export const ARTIFACT_NAMES: readonly string[] = [
  "research_brief",
  "proposal_packet",
  "brief",
  "script",
  "character_design",
  "rig_plan",
  "pose_library",
  "scene_plan",
  "action_timeline",
  "asset_manifest",
  "edit_decisions",
  "render_report",
  "publish_log",
  "review",
  "cost_log",
  "decision_log",
  "source_media_review",
  "final_review",
  "character_qa_report",
  "video_analysis_brief",
];

const ARTIFACT_NAME_SET = new Set(ARTIFACT_NAMES);

/** Shared Ajv instance (allErrors + formats), reused across all loaders. */
export const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

/** Cache of compiled validators keyed by absolute schema path. */
const _validatorCache = new Map<string, ValidateFunction>();

/** Read + parse a JSON schema file from disk (no caching of the raw object). */
function readSchemaFile(absPath: string): Record<string, unknown> {
  const text = fs.readFileSync(absPath, "utf-8");
  return JSON.parse(text) as Record<string, unknown>;
}

/** Compile (and memoize) a validator for an absolute schema path. */
export function getValidator(absPath: string): ValidateFunction {
  const cached = _validatorCache.get(absPath);
  if (cached) return cached;
  const schema = readSchemaFile(absPath);
  const validate = ajv.compile(schema);
  _validatorCache.set(absPath, validate);
  return validate;
}

/**
 * Format ajv errors into a single human-readable message
 * (jsonschema raises with a `.message`; we join ajv's error array).
 */
export function formatErrors(validate: ValidateFunction): string {
  if (!validate.errors || validate.errors.length === 0) return "validation failed";
  return validate.errors
    .map((e) => `${e.instancePath || "(root)"} ${e.message ?? ""}`.trim())
    .join("; ");
}

/** Load a raw JSON schema by artifact name (mirrors load_schema). */
export function loadSchema(name: string): Record<string, unknown> {
  const absPath = path.join(ARTIFACT_SCHEMA_DIR, `${name}.schema.json`);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Schema not found: ${absPath}`);
  }
  return readSchemaFile(absPath);
}

/**
 * Validate artifact data against its named schema. Throws on failure
 * (mirrors validate_artifact, which raises jsonschema.ValidationError).
 */
export function validateArtifact(name: string, data: unknown): void {
  const absPath = path.join(ARTIFACT_SCHEMA_DIR, `${name}.schema.json`);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Schema not found: ${absPath}`);
  }
  const validate = getValidator(absPath);
  if (!validate(data)) {
    throw new Error(`Artifact '${name}' failed schema validation: ${formatErrors(validate)}`);
  }
}

/** Whether a name is a known artifact with a schema (mirrors `name in ARTIFACT_NAMES`). */
export function isArtifactName(name: string): boolean {
  return ARTIFACT_NAME_SET.has(name);
}

/** List all available artifact schema names (mirrors list_schemas). */
export function listSchemas(): string[] {
  return fs
    .readdirSync(ARTIFACT_SCHEMA_DIR)
    .filter((f) => f.endsWith(".schema.json"))
    .map((f) => f.replace(/\.schema\.json$/, ""));
}
