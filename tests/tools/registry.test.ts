/**
 * Focused registry contract test (Expert A slice).
 *
 * Verifies the three representative tools register via discover(), that
 * providerMenu() groups them by capability with correct configured/total, that
 * providerMenuSummary() lifts composition_runtimes from video_compose (ffmpeg
 * is installed in this environment → true), and that elevenlabs surfaces as an
 * unavailable setup_offer when no API key is present.
 *
 * The repo .env carries ELEVENLABS_API_KEY and FAL_KEY, which base_tool loads
 * via dotenv at import time. We delete those env vars BEFORE discovery so the
 * API tools deterministically report UNAVAILABLE regardless of .env contents
 * (getStatus reads process.env live).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { registry } from "../../src/tools/tool_registry.js";
import { ToolStatus } from "../../src/tools/base_tool.js";

beforeAll(async () => {
  // Force API tools UNAVAILABLE for deterministic assertions.
  delete process.env.ELEVENLABS_API_KEY;
  delete process.env.FAL_KEY;
  delete process.env.FAL_AI_API_KEY;
  registry.clear();
  await registry.discover();
});

describe("ToolRegistry discovery", () => {
  it("registers the three representative tools", async () => {
    // discover() is idempotent; a second call returns the same names.
    const names = await registry.discover();
    expect(names).toContain("video_compose");
    expect(names).toContain("elevenlabs_tts");
    expect(names).toContain("flux_image");

    expect(registry.get("video_compose")).toBeDefined();
    expect(registry.get("elevenlabs_tts")).toBeDefined();
    expect(registry.get("flux_image")).toBeDefined();
  });

  it("reports video_compose available (ffmpeg installed) and API tools unavailable", () => {
    expect(registry.get("video_compose")!.getStatus()).toBe(
      ToolStatus.AVAILABLE
    );
    expect(registry.get("elevenlabs_tts")!.getStatus()).toBe(
      ToolStatus.UNAVAILABLE
    );
    expect(registry.get("flux_image")!.getStatus()).toBe(
      ToolStatus.UNAVAILABLE
    );
  });
});

describe("providerMenu()", () => {
  it("groups tools by capability with correct configured/total", () => {
    const menu = registry.providerMenu();

    // video_post: video_compose, available (ffmpeg present)
    const videoPost = menu.video_post as {
      total: number;
      configured: number;
      available: Array<{ name: string }>;
    };
    expect(videoPost).toBeDefined();
    expect(videoPost.total).toBeGreaterThanOrEqual(1);
    expect(videoPost.configured).toBeGreaterThanOrEqual(1);
    expect(videoPost.available.map((e) => e.name)).toContain("video_compose");

    // tts: elevenlabs_tts, unavailable (no key)
    const tts = menu.tts as {
      total: number;
      configured: number;
      unavailable: Array<{ name: string }>;
    };
    expect(tts).toBeDefined();
    expect(tts.total).toBeGreaterThanOrEqual(1);
    expect(tts.configured).toBe(0);
    expect(tts.unavailable.map((e) => e.name)).toContain("elevenlabs_tts");

    // image_generation: flux_image, unavailable (no key)
    const imageGen = menu.image_generation as {
      total: number;
      configured: number;
      unavailable: Array<{ name: string }>;
    };
    expect(imageGen).toBeDefined();
    expect(imageGen.total).toBeGreaterThanOrEqual(1);
    expect(imageGen.configured).toBe(0);
    expect(imageGen.unavailable.map((e) => e.name)).toContain("flux_image");
  });

  it("carries render_engines on the video_compose menu entry", () => {
    const menu = registry.providerMenu();
    const videoPost = menu.video_post as {
      available: Array<{ name: string; render_engines?: Record<string, boolean> }>;
    };
    const entry = videoPost.available.find((e) => e.name === "video_compose")!;
    expect(entry.render_engines).toBeDefined();
    expect(entry.render_engines!.ffmpeg).toBe(true);
  });
});

describe("providerMenuSummary()", () => {
  it("lifts composition_runtimes.ffmpeg === true from video_compose", () => {
    const summary = registry.providerMenuSummary();
    expect(summary.composition_runtimes.ffmpeg).toBe(true);
  });

  it("offers elevenlabs as an unavailable setup_offer (env-var fix)", () => {
    const summary = registry.providerMenuSummary();
    const offer = summary.setup_offers.find((o) => o.tool === "elevenlabs_tts");
    expect(offer).toBeDefined();
    expect(offer!.capability).toBe("tts");
    expect(offer!.install_instructions.toLowerCase()).toContain("elevenlabs_api_key");
  });

  it("rolls up capabilities with deduped provider lists", () => {
    const summary = registry.providerMenuSummary();
    const tts = summary.capabilities.find((c) => c.capability === "tts")!;
    expect(tts.configured).toBe(0);
    expect(tts.total).toBeGreaterThanOrEqual(1);
    expect(tts.unavailable_providers).toContain("elevenlabs");
    expect(tts.available_providers).toEqual([]);
  });
});
