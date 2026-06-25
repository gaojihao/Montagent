/**
 * Checkpoint writer/reader for pipeline state persistence
 * (1:1 port of lib/checkpoint.py).
 *
 * Each stage writes a checkpoint after completion. The orchestrator uses
 * checkpoints to resume pipelines and to present state at human checkpoints.
 *
 * Parity notes vs. Python:
 *  - Checkpoints live at `<pipelineDir>/<project_id>/checkpoint_<stage>.json`
 *    and JSON is written with 2-space indent (json.dump(..., indent=2)).
 *  - status ∈ {completed, failed, awaiting_human, in_progress}; `completed`/
 *    `awaiting_human` must carry the stage's canonical artifact, which is
 *    validated against its schema via the shared ajv instance.
 *  - The checkpoint envelope is validated against
 *    schemas/checkpoints/checkpoint.schema.json (same file as Python).
 *  - timestamp uses ISO-8601 UTC (Python datetime.now(timezone.utc).isoformat()).
 *  - Function names mirror Python (snake_case → camelCase).
 */
import fs from "node:fs";
import path from "node:path";

import { SCHEMA_ROOT, getValidator, formatErrors, isArtifactName, validateArtifact } from "./schema_validator.js";
import { loadPipeline, getStageOrder } from "./pipeline_loader.js";

// All known stages across all pipelines (used only for artifact name lookup).
export const ALL_KNOWN_STAGES: ReadonlySet<string> = new Set([
  "research",
  "proposal",
  "idea",
  "script",
  "scene_plan",
  "assets",
  "edit",
  "compose",
  "publish",
]);

// Backward-compatible canonical stage order. New code should prefer
// getPipelineStages(pipelineType).
export const STAGES: readonly string[] = [
  "research",
  "proposal",
  "idea",
  "script",
  "scene_plan",
  "assets",
  "edit",
  "compose",
  "publish",
];

export const CANONICAL_STAGE_ARTIFACTS: Readonly<Record<string, string>> = {
  research: "research_brief",
  proposal: "proposal_packet",
  idea: "brief",
  script: "script",
  scene_plan: "scene_plan",
  assets: "asset_manifest",
  edit: "edit_decisions",
  compose: "render_report",
  publish: "publish_log",
};

// Additional artifacts that may be produced alongside canonical ones.
export const SUPPLEMENTARY_ARTIFACTS: ReadonlySet<string> = new Set([
  "source_media_review",
  "final_review",
  "video_analysis_brief",
]);

const CHECKPOINT_SCHEMA_PATH = path.join(SCHEMA_ROOT, "checkpoints", "checkpoint.schema.json");

/** Raised when a checkpoint or its canonical artifacts are invalid. */
export class CheckpointValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckpointValidationError";
  }
}

export type Checkpoint = Record<string, any>;

/**
 * Return the ordered stage list for a specific pipeline.
 *
 * Falls back to STAGES (deterministic canonical order) when pipelineType is
 * not provided or the manifest cannot be loaded.
 */
export function getPipelineStages(pipelineType: string | null | undefined): string[] {
  if (pipelineType === null || pipelineType === undefined) {
    // Deterministic canonical fallback (Python logs a warning here).
    return [...STAGES];
  }
  try {
    const manifest = loadPipeline(pipelineType);
    return getStageOrder(manifest);
  } catch {
    // Graceful fallback: return all known stages in canonical order.
    return [...STAGES];
  }
}

function validateArtifactsForStage(
  stage: string,
  status: string,
  artifacts: Record<string, any>,
): void {
  const requiredArtifact = CANONICAL_STAGE_ARTIFACTS[stage];
  if (
    (status === "completed" || status === "awaiting_human") &&
    requiredArtifact !== undefined &&
    !(requiredArtifact in artifacts)
  ) {
    throw new CheckpointValidationError(
      `Stage '${stage}' with status '${status}' must include canonical artifact '${requiredArtifact}'`,
    );
  }

  for (const [artifactName, artifactData] of Object.entries(artifacts)) {
    if (!isArtifactName(artifactName)) continue;
    if (typeof artifactData !== "object" || artifactData === null || Array.isArray(artifactData)) {
      throw new CheckpointValidationError(
        `Artifact '${artifactName}' must be a JSON object matching its schema`,
      );
    }
    try {
      validateArtifact(artifactName, artifactData);
    } catch (exc) {
      throw new CheckpointValidationError(
        `Artifact '${artifactName}' failed schema validation: ${(exc as Error).message}`,
      );
    }
  }
}

/**
 * Validate checkpoint structure and canonical artifact payloads.
 *
 * Uses pipeline_type (if present) to resolve the valid stage list; otherwise
 * falls back to ALL_KNOWN_STAGES.
 */
export function validateCheckpoint(checkpoint: Checkpoint): void {
  const stage = checkpoint.stage;
  const status = checkpoint.status;
  const artifacts = checkpoint.artifacts;
  const pipelineType = checkpoint.pipeline_type;

  const validStages: Set<string> = pipelineType
    ? new Set(getPipelineStages(pipelineType))
    : new Set(ALL_KNOWN_STAGES);

  if (typeof stage !== "string" || !validStages.has(stage)) {
    throw new CheckpointValidationError(
      `Invalid stage: ${JSON.stringify(stage)} for pipeline ${JSON.stringify(pipelineType)}. ` +
        `Valid stages: ${[...validStages].sort().join(", ")}`,
    );
  }
  if (typeof status !== "string") {
    throw new CheckpointValidationError(`Invalid status: ${JSON.stringify(status)}`);
  }
  if (typeof artifacts !== "object" || artifacts === null || Array.isArray(artifacts)) {
    throw new CheckpointValidationError("Checkpoint artifacts must be a dictionary");
  }

  validateArtifactsForStage(stage, status, artifacts);

  const validate = getValidator(CHECKPOINT_SCHEMA_PATH);
  if (!validate(checkpoint)) {
    throw new CheckpointValidationError(`Checkpoint failed schema validation: ${formatErrors(validate)}`);
  }
}

function checkpointPath(pipelineDir: string, projectId: string, stage: string): string {
  return path.join(pipelineDir, projectId, `checkpoint_${stage}.json`);
}

function decisionLogPath(pipelineDir: string, projectId: string): string {
  return path.join(pipelineDir, projectId, "decision_log.json");
}

/**
 * Append new decisions to the project-level decision log, deduping by
 * decision_id. Mirrors Python _merge_decision_log.
 */
function mergeDecisionLog(
  pipelineDir: string,
  projectId: string,
  newLog: Record<string, any>,
): void {
  const logPath = decisionLogPath(pipelineDir, projectId);
  let existing: Record<string, any>;
  if (fs.existsSync(logPath)) {
    existing = JSON.parse(fs.readFileSync(logPath, "utf-8"));
  } else {
    existing = { version: "1.0", project_id: projectId, decisions: [] };
  }

  const existingIds = new Set((existing.decisions ?? []).map((d: any) => d.decision_id));
  for (const decision of newLog.decisions ?? []) {
    if (!existingIds.has(decision?.decision_id)) {
      existing.decisions.push(decision);
    }
  }

  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, JSON.stringify(existing, null, 2));
}

export interface WriteCheckpointOptions {
  pipelineType?: string | null;
  stylePlaybook?: string | null;
  checkpointPolicy?: string;
  humanApprovalRequired?: boolean;
  humanApproved?: boolean;
  review?: Record<string, any> | null;
  costSnapshot?: Record<string, any> | null;
  error?: string | null;
  metadata?: Record<string, any> | null;
}

/**
 * Write a checkpoint file for a pipeline stage. Returns the absolute path.
 *
 * @throws Error for an invalid stage; CheckpointValidationError for an invalid
 *   envelope or canonical artifact (mirrors Python ValueError vs.
 *   CheckpointValidationError split).
 */
export function writeCheckpoint(
  pipelineDir: string,
  projectId: string,
  stage: string,
  status: string,
  artifacts: Record<string, any>,
  options: WriteCheckpointOptions = {},
): string {
  const {
    pipelineType = null,
    stylePlaybook = null,
    checkpointPolicy = "guided",
    humanApprovalRequired = false,
    humanApproved = false,
    review = null,
    costSnapshot = null,
    error = null,
    metadata = null,
  } = options;

  const validStages: Set<string> = pipelineType
    ? new Set(getPipelineStages(pipelineType))
    : new Set(ALL_KNOWN_STAGES);
  if (!validStages.has(stage)) {
    throw new Error(
      `Invalid stage: ${JSON.stringify(stage)} for pipeline ${JSON.stringify(pipelineType)}. ` +
        `Valid stages: ${[...validStages].sort().join(", ")}`,
    );
  }

  const checkpoint: Checkpoint = {
    version: "1.0",
    project_id: projectId,
    pipeline_type: pipelineType ?? "unknown",
    stage,
    status,
    timestamp: new Date().toISOString(),
    checkpoint_policy: checkpointPolicy,
    human_approval_required: humanApprovalRequired,
    human_approved: humanApproved,
    artifacts,
  };
  if (stylePlaybook !== null) checkpoint.style_playbook = stylePlaybook;
  if (review !== null) checkpoint.review = review;
  if (costSnapshot !== null) checkpoint.cost_snapshot = costSnapshot;
  if (error !== null) checkpoint.error = error;
  if (metadata !== null) checkpoint.metadata = metadata;

  // Merge decision_log: append new decisions to the project-level file, then
  // write the reference back into proposal_packet / render_report artifacts.
  if (
    "decision_log" in artifacts &&
    typeof artifacts.decision_log === "object" &&
    artifacts.decision_log !== null &&
    !Array.isArray(artifacts.decision_log)
  ) {
    mergeDecisionLog(pipelineDir, projectId, artifacts.decision_log);
    const logRef = decisionLogPath(pipelineDir, projectId);

    for (const artifactKey of ["proposal_packet", "render_report"] as const) {
      const top = artifacts[artifactKey];
      if (typeof top === "object" && top !== null && !Array.isArray(top)) {
        if (artifactKey === "proposal_packet") {
          // proposal_packet stores it under production_plan
          const plan = top.production_plan;
          if (typeof plan === "object" && plan !== null && !Array.isArray(plan)) {
            plan.decision_log_ref = logRef;
          }
        } else {
          top.decision_log_ref = logRef;
        }
      }
    }
  }

  validateCheckpoint(checkpoint);

  const filePath = checkpointPath(pipelineDir, projectId, stage);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(checkpoint, null, 2));

  return filePath;
}

/** Read a checkpoint file. Returns null if not found. */
export function readCheckpoint(
  pipelineDir: string,
  projectId: string,
  stage: string,
): Checkpoint | null {
  const filePath = checkpointPath(pipelineDir, projectId, stage);
  if (!fs.existsSync(filePath)) return null;
  const checkpoint = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Checkpoint;
  validateCheckpoint(checkpoint);
  return checkpoint;
}

/** Find the most recent checkpoint for a project (by file mtime). */
export function getLatestCheckpoint(
  pipelineDir: string,
  projectId: string,
): Checkpoint | null {
  const projectDir = path.join(pipelineDir, projectId);
  if (!fs.existsSync(projectDir)) return null;

  const checkpoints = fs
    .readdirSync(projectDir)
    .filter((f) => f.startsWith("checkpoint_") && f.endsWith(".json"))
    .map((f) => {
      const full = path.join(projectDir, f);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  if (checkpoints.length === 0) return null;

  const checkpoint = JSON.parse(fs.readFileSync(checkpoints[0]!.full, "utf-8")) as Checkpoint;
  validateCheckpoint(checkpoint);
  return checkpoint;
}

/**
 * Return list of stages that have a completed checkpoint.
 *
 * When pipelineType is provided, only checks stages defined in that pipeline's
 * manifest (avoids false positives from leftover checkpoints of another type).
 */
export function getCompletedStages(
  pipelineDir: string,
  projectId: string,
  pipelineType: string | null = null,
): string[] {
  const stagesToCheck = getPipelineStages(pipelineType);
  const completed: string[] = [];
  for (const stage of stagesToCheck) {
    const cp = readCheckpoint(pipelineDir, projectId, stage);
    if (cp && cp.status === "completed") {
      completed.push(stage);
    }
  }
  return completed;
}

/**
 * Determine the next stage to run based on completed checkpoints.
 *
 * Uses pipeline-specific stage order so pipelines with different sequences
 * progress correctly.
 */
export function getNextStage(
  pipelineDir: string,
  projectId: string,
  pipelineType: string | null = null,
): string | null {
  const stages = pipelineType ? getPipelineStages(pipelineType) : [...STAGES];
  const completed = new Set(getCompletedStages(pipelineDir, projectId, pipelineType));
  for (const stage of stages) {
    if (!completed.has(stage)) return stage;
  }
  return null;
}
