/**
 * Schema / loader contract tests. Ports the language-agnostic checks from
 * /Users/fanhui/Montagent/tests/contracts/test_phase0_contracts.py and
 * test_phase1_contracts.py:
 *  - TestSchemas: schemas loadable, brief validates / rejects, video brief.
 *  - TestPipelineManifests + TestTalkingHeadManifest: every manifest validates
 *    against the manifest schema; stage-order / required-tools / sub-stage
 *    helpers behave; framework-smoke + talking-head + animated-explainer shapes.
 *  - TestConfig: defaults and YAML load.
 *  - Plus a "every playbook validates against playbook.schema.json" sweep.
 *
 * No network or API keys required.
 */
import { describe, it, expect } from "vitest";

import {
  loadSchema,
  validateArtifact,
  listSchemas,
} from "../../src/lib/schema_validator.js";
import {
  loadPipeline,
  listPipelines,
  getStageOrder,
  getRequiredTools,
  getStageSkill,
  getStageReviewFocus,
  getStageSubStages,
  pipelineSupportsReferenceInput,
} from "../../src/lib/pipeline_loader.js";
import { loadPlaybook, listPlaybooks } from "../../src/styles/playbook_loader.js";
import { loadConfig, defaultConfig } from "../../src/lib/config.js";
import { sampleArtifact } from "./sample_artifacts.js";

// ---- Schemas ----

describe("Schemas", () => {
  it("loads all artifact schemas, each carrying $schema", () => {
    const names = listSchemas();
    expect(names.length).toBeGreaterThanOrEqual(7);
    for (const name of names) {
      const schema = loadSchema(name);
      expect(schema).toHaveProperty("$schema");
    }
  });

  it("validates a well-formed brief", () => {
    expect(() => validateArtifact("brief", sampleArtifact("brief"))).not.toThrow();
  });

  it("rejects an incomplete brief", () => {
    expect(() => validateArtifact("brief", { version: "1.0" })).toThrow();
  });

  it("validates a video_analysis_brief", () => {
    expect(() =>
      validateArtifact("video_analysis_brief", sampleArtifact("video_analysis_brief")),
    ).not.toThrow();
  });
});

// ---- Pipeline manifests ----

describe("Pipeline manifests", () => {
  // Manifests known to validate against the schema. Mirrors the set the
  // Python contract tests actually load; the upstream repo also ships two
  // intentionally-nonconforming manifests (documentary-montage has category
  // 'documentary'; screen-demo has an extra 'production_modes' key) which the
  // Python jsonschema rejects identically — so they are excluded here too,
  // preserving 1:1 behavior rather than masking it.
  const KNOWN_INVALID_MANIFESTS = new Set(["documentary-montage", "screen-demo"]);

  it("every conforming pipeline manifest validates against the manifest schema", () => {
    const names = listPipelines().filter((n) => !KNOWN_INVALID_MANIFESTS.has(n));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      // loadPipeline throws if the manifest fails schema validation.
      expect(() => loadPipeline(name), `manifest ${name} should validate`).not.toThrow();
    }
  });

  it("known-nonconforming manifests are rejected (parity with Python jsonschema)", () => {
    for (const name of KNOWN_INVALID_MANIFESTS) {
      expect(() => loadPipeline(name), `manifest ${name} should be rejected`).toThrow();
    }
  });

  it("framework-smoke has the expected stage order and no required tools", () => {
    const manifest = loadPipeline("framework-smoke");
    expect(manifest.name).toBe("framework-smoke");
    expect(getStageOrder(manifest)).toEqual(["research", "script"]);
    expect([...getRequiredTools(manifest)]).toEqual([]);
  });

  it("framework-smoke is listed", () => {
    expect(listPipelines()).toContain("framework-smoke");
  });

  it("stage skill / review-focus lookups return correct shapes", () => {
    const manifest = loadPipeline("framework-smoke");
    const skill = getStageSkill(manifest, "idea");
    expect(skill === null || typeof skill === "string").toBe(true);
    expect(Array.isArray(getStageReviewFocus(manifest, "idea"))).toBe(true);
  });

  it("animated-explainer exposes reference-input sub-stages and analysis tools", () => {
    const manifest = loadPipeline("animated-explainer");
    expect(pipelineSupportsReferenceInput(manifest)).toBe(true);
    expect([...getRequiredTools(manifest)]).toContain("video_analyzer");

    const allUnits = getStageOrder(manifest, { includeSubStages: true });
    expect(allUnits).toContain("proposal.sample");

    const activeSubStages = getStageSubStages(manifest, "proposal", {
      context: { video_analysis_brief_exists: true },
      includeInactive: false,
    });
    expect(activeSubStages.some((s) => s.name === "sample")).toBe(true);
  });

  it("talking-head has the full canonical stage order and references phase-1 tools", () => {
    const manifest = loadPipeline("talking-head");
    expect(manifest.name).toBe("talking-head");
    expect(getStageOrder(manifest)).toEqual([
      "idea",
      "script",
      "scene_plan",
      "assets",
      "edit",
      "compose",
      "publish",
    ]);
    const tools = getRequiredTools(manifest);
    const phase1 = new Set([
      "transcriber",
      "video_trimmer",
      "subtitle_gen",
      "frame_sampler",
      "audio_mixer",
      "video_compose",
    ]);
    const intersection = [...tools].filter((t) => phase1.has(t));
    expect(intersection.length).toBeGreaterThan(0);
  });
});

// ---- Playbooks ----

describe("Style playbooks", () => {
  // anime-ghibli ships with extra keys not permitted by playbook.schema.json
  // (e.g. identity.section_title, additional asset_generation/overlay props);
  // Python's jsonschema rejects it identically, so it is excluded here to keep
  // 1:1 behavior. The remaining three are the conforming, schema-valid set.
  const KNOWN_INVALID_PLAYBOOKS = new Set(["anime-ghibli"]);

  it("every conforming playbook validates against playbook.schema.json", () => {
    const names = listPlaybooks().filter((n) => !KNOWN_INVALID_PLAYBOOKS.has(n));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(() => loadPlaybook(name), `playbook ${name} should validate`).not.toThrow();
    }
  });

  it("known-nonconforming playbook is rejected (parity with Python jsonschema)", () => {
    for (const name of KNOWN_INVALID_PLAYBOOKS) {
      expect(() => loadPlaybook(name), `playbook ${name} should be rejected`).toThrow();
    }
  });
});

// ---- Config ----

describe("Config", () => {
  it("provides Pydantic-equivalent defaults", () => {
    const config = defaultConfig();
    expect(config.llm.provider).toBe("anthropic");
    expect(config.budget.mode).toBe("warn");
    expect(config.checkpoint.policy).toBe("guided");
  });

  it("loads config.yaml from the project root", () => {
    const config = loadConfig();
    expect(config.budget.total_usd).toBe(10.0);
  });
});
