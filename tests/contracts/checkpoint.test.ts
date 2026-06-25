/**
 * Checkpoint contract tests (ported from
 * /Users/fanhui/Montagent/tests/contracts/test_phase0_contracts.py — the
 * TestCheckpoint class). Verifies write/read round-trip, get_next_stage
 * ordering, invalid-stage/status rejection, canonical-artifact enforcement,
 * and that supplementary artifacts are schema-validated.
 *
 * No network or API keys required; checkpoints are written to an OS temp dir.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CheckpointValidationError,
  writeCheckpoint,
  readCheckpoint,
  getNextStage,
} from "../../src/lib/checkpoint.js";
import { sampleArtifact } from "./sample_artifacts.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "om-ckpt-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Checkpoint", () => {
  it("write/read round-trips and preserves artifact payload", () => {
    writeCheckpoint(tmpDir, "test_project", "research", "completed", {
      research_brief: sampleArtifact("research_brief"),
    });
    const cp = readCheckpoint(tmpDir, "test_project", "research");
    expect(cp).not.toBeNull();
    expect(cp!.stage).toBe("research");
    expect(cp!.status).toBe("completed");
    expect(cp!.artifacts.research_brief.topic).toBe("Test Topic");
  });

  it("get_next_stage advances as stages complete", () => {
    expect(getNextStage(tmpDir, "proj")).toBe("research");
    writeCheckpoint(tmpDir, "proj", "research", "completed", {
      research_brief: sampleArtifact("research_brief"),
    });
    expect(getNextStage(tmpDir, "proj")).toBe("proposal");
  });

  it("rejects an invalid stage with a plain Error (ValueError parity)", () => {
    expect(() => writeCheckpoint(tmpDir, "proj", "invalid_stage", "completed", {})).toThrow();
  });

  it("rejects a canonical artifact that fails its schema", () => {
    expect(() =>
      writeCheckpoint(tmpDir, "proj", "research", "completed", {
        research_brief: { topic: "missing schema fields" },
      }),
    ).toThrow(CheckpointValidationError);
  });

  it("rejects a completed checkpoint missing its canonical artifact", () => {
    expect(() => writeCheckpoint(tmpDir, "proj", "research", "completed", {})).toThrow(
      CheckpointValidationError,
    );
  });

  it("rejects an unknown status value", () => {
    expect(() =>
      writeCheckpoint(tmpDir, "proj", "research", "mystery", {
        research_brief: sampleArtifact("research_brief"),
      }),
    ).toThrow(CheckpointValidationError);
  });

  it("validates supplementary artifacts (video_analysis_brief) carried alongside", () => {
    writeCheckpoint(tmpDir, "proj", "proposal", "completed", {
      proposal_packet: sampleArtifact("proposal_packet"),
      video_analysis_brief: sampleArtifact("video_analysis_brief"),
    });
    const cp = readCheckpoint(tmpDir, "proj", "proposal");
    expect(cp).not.toBeNull();
    expect(cp!.artifacts).toHaveProperty("video_analysis_brief");
  });
});
