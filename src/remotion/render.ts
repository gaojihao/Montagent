/**
 * Render the curated zero-key Remotion demos (TypeScript port of render_demo.py).
 *
 * This module is Remotion-specific by design — the demos live in
 * `remotion-composer/public/demo-props/` as JSON props for existing React scene
 * components. It is the heart of the FREE (zero-API-key) flow: no API key, no
 * paid service, just a local headless Chromium render.
 *
 * Parity with the Python original (`render_demo.py`):
 *  - Same demo discovery (sorted *.json stems in public/demo-props/).
 *  - Same 3 demo descriptions.
 *  - Same props validation (non-empty `cuts` array).
 *  - Same composition (`Explainer`), same codec (h264), same output dir
 *    (`projects/demos/renders/<name>.mp4`), same resolution/fps (1920x1080@30,
 *    duration derived from props via the composition's calculateMetadata).
 *
 * The ONE intentional upgrade: instead of shelling out to `npx remotion render`,
 * we drive the programmatic `@remotion/bundler` + `@remotion/renderer` API. The
 * OUTPUT is identical — same composition, same inputProps, same encoder settings.
 */
import fs from "node:fs";
import path from "node:path";

import { bundle } from "@remotion/bundler";
import {
  ensureBrowser,
  renderMedia,
  selectComposition,
  type Codec,
} from "@remotion/renderer";

import { PROJECT_ROOT } from "../tools/base_tool.js";

// ---------------------------------------------------------------------------
// Paths (mirror render_demo.py constants, rooted at PROJECT_ROOT)
// ---------------------------------------------------------------------------
const COMPOSER_DIR = path.join(PROJECT_ROOT, "remotion-composer");
const PROPS_DIR = path.join(COMPOSER_DIR, "public", "demo-props");
const OUTPUT_DIR = path.join(PROJECT_ROOT, "projects", "demos", "renders");
/** Remotion entry point — must be an absolute path for the bundler. */
const ENTRY_POINT = path.join(COMPOSER_DIR, "src", "index.tsx");
/** The composition id registered in remotion-composer/src/Root.tsx. */
const COMPOSITION_ID = "Explainer";

// ---------------------------------------------------------------------------
// Demo descriptions (verbatim from render_demo.py DEMO_DESCRIPTIONS)
// ---------------------------------------------------------------------------
export const DEMO_DESCRIPTIONS: Record<string, string> = {
  "world-in-numbers": "Global scale story with titles, stats, and charts",
  "code-to-screen": "Developer workflow explainer with comparison and KPI cards",
  "focusflow-pitch": "Startup-style pitch built only from Remotion components",
};

/** Fallback description, matching Python's `.get(name, "Checked-in Remotion demo")`. */
const DEFAULT_DESCRIPTION = "Checked-in Remotion demo";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface DemoInfo {
  name: string;
  description: string;
  propsPath: string;
}

export interface RenderDemoResult {
  name: string;
  outputPath: string;
  sizeBytes: number;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  codec: string;
}

export interface RenderOptions {
  /** Override the output directory (default: projects/demos/renders). */
  outDir?: string;
  /** Override the codec (default: "h264"). */
  codec?: string;
}

// ---------------------------------------------------------------------------
// Discovery — port of discover_demos()
// ---------------------------------------------------------------------------

/**
 * Discover demos from `remotion-composer/public/demo-props/*.json`, sorted by
 * filename (the demo name is the file stem). Sync, like the Python original.
 * Returns [] when the props dir does not exist.
 */
export function listDemos(): DemoInfo[] {
  if (!fs.existsSync(PROPS_DIR)) {
    return [];
  }
  const files = fs
    .readdirSync(PROPS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort(); // lexicographic, matching Python's sorted(glob(...))

  return files.map((file) => {
    const name = path.basename(file, ".json");
    return {
      name,
      description: DEMO_DESCRIPTIONS[name] ?? DEFAULT_DESCRIPTION,
      propsPath: path.join(PROPS_DIR, file),
    };
  });
}

// ---------------------------------------------------------------------------
// Props loading & validation — port of validate_props_file()
// ---------------------------------------------------------------------------

/**
 * Read a demo props JSON file and validate it defines at least one cut.
 * Mirrors Python's validate_props_file SystemExit message in spirit.
 * Returns the parsed props object (used as Remotion inputProps).
 */
function loadAndValidateProps(propsPath: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(propsPath, "utf-8");
  } catch {
    throw new Error(`Error: props file not found: ${propsPath}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Error: ${propsPath} is not valid JSON: ${(err as Error).message}`
    );
  }

  const cuts = (payload as { cuts?: unknown } | null)?.cuts;
  if (!Array.isArray(cuts) || cuts.length === 0) {
    throw new Error(`Error: ${propsPath} must define at least one cut.`);
  }

  return payload as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Bundle caching — bundle the Remotion project at most once per process.
// ---------------------------------------------------------------------------
let bundlePromise: Promise<string> | null = null;

/**
 * Bundle the Remotion project (entryPoint = remotion-composer/src/index.tsx).
 * Memoized so rendering multiple demos reuses a single serve URL. Default
 * webpackOverride is intentional (the composer ships its own webpack config via
 * the bundler's auto-detection; no overrides needed for parity).
 */
function getServeUrl(): Promise<string> {
  if (!bundlePromise) {
    bundlePromise = bundle({ entryPoint: ENTRY_POINT });
  }
  return bundlePromise;
}

// ---------------------------------------------------------------------------
// Render a single demo — port of render_demo()
// ---------------------------------------------------------------------------

/**
 * Render one named demo to `projects/demos/renders/<name>.mp4` and return
 * metadata. Validates the props file (non-empty `cuts`), bundles the Remotion
 * project once, selects the `Explainer` composition (so its calculateMetadata
 * computes durationInFrames from the props), and renders with the h264 codec.
 *
 * Throws a clear error for an unknown demo name or missing/invalid props,
 * mirroring the Python SystemExit messages.
 */
export async function renderDemo(
  name: string,
  opts: RenderOptions = {}
): Promise<RenderDemoResult> {
  const demos = listDemos();
  if (demos.length === 0) {
    throw new Error(`Error: No demo prop files were found in ${PROPS_DIR}.`);
  }

  const demo = demos.find((d) => d.name === name);
  if (!demo) {
    const available = demos.map((d) => d.name).join(", ");
    throw new Error(
      `Unknown demo '${name}'. Available demos: ${available}`
    );
  }

  const codec = (opts.codec ?? "h264") as Codec;
  const outDir = opts.outDir ?? OUTPUT_DIR;

  // Validate props and load them as inputProps.
  const inputProps = loadAndValidateProps(demo.propsPath);

  // Ensure the headless Chromium shell is present (free, first-run download).
  await ensureBrowser();

  // Bundle once (reused across multiple renders in the same process).
  const serveUrl = await getServeUrl();

  // Select the Explainer composition — passing inputProps runs its
  // calculateMetadata, which sets durationInFrames = ceil((maxOut + 1) * 30).
  const composition = await selectComposition({
    serveUrl,
    id: COMPOSITION_ID,
    inputProps,
  });

  fs.mkdirSync(outDir, { recursive: true });
  const outputLocation = path.join(outDir, `${name}.mp4`);

  await renderMedia({
    composition,
    serveUrl,
    codec,
    outputLocation,
    inputProps,
  });

  let sizeBytes = 0;
  try {
    sizeBytes = fs.statSync(outputLocation).size;
  } catch {
    throw new Error(
      `Render finished without creating the expected output file: ${outputLocation}`
    );
  }

  return {
    name,
    outputPath: outputLocation,
    sizeBytes,
    width: composition.width,
    height: composition.height,
    fps: composition.fps,
    durationInFrames: composition.durationInFrames,
    codec,
  };
}

// ---------------------------------------------------------------------------
// Render all demos — port of the `selected = demos` branch in main()
// ---------------------------------------------------------------------------

/**
 * Render every discovered demo (sorted). Reuses a single bundle across all
 * renders. Throws if no demos are found.
 */
export async function renderAllDemos(
  opts: RenderOptions = {}
): Promise<RenderDemoResult[]> {
  const demos = listDemos();
  if (demos.length === 0) {
    throw new Error(`Error: No demo prop files were found in ${PROPS_DIR}.`);
  }

  const results: RenderDemoResult[] = [];
  for (const demo of demos) {
    results.push(await renderDemo(demo.name, opts));
  }
  return results;
}
