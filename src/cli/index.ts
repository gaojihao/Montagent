#!/usr/bin/env node
/**
 * montagent CLI — single binary that collects every "launch command".
 *
 * Subcommands (1:1 with the plan's §4 CLI mapping):
 *   preflight [--summary]            registry.providerMenu() / providerMenuSummary()
 *   catalog   [--by-capability|--by-provider]
 *   runtimes                         report render_engines (ffmpeg/remotion/hyperframes)
 *   demo      [name] [--list]        render zero-key Remotion demos (the FREE flow)
 *   hyperframes <doctor|warm>
 *   run <tool> --params <json>       generic tool execution
 *
 * Dev launch: `tsx src/cli/index.ts` (via ./bin/montagent). No build step needed.
 */
import { Command } from "commander";
import { execa } from "execa";

import { registry } from "../tools/tool_registry.js";
import { commandExists } from "../tools/base_tool.js";

function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

const program = new Command();
program
  // The single CLI binary; the instruction layer (skills/AGENT_GUIDE) invokes `montagent <subcommand>`.
  .name("montagent")
  .description("Montagent — an AI agent that turns a brief into a finished video")
  .version("0.1.0");

// ---- preflight --------------------------------------------------------------
program
  .command("preflight")
  .description("Print the capability/provider menu (use --summary for the compact rollup).")
  .option("--summary", "Print the compact provider_menu_summary rollup instead of the full menu.")
  .action(async (opts: { summary?: boolean }) => {
    await registry.discover();
    printJson(opts.summary ? registry.providerMenuSummary() : registry.providerMenu());
  });

// ---- catalog ----------------------------------------------------------------
program
  .command("catalog")
  .description("Dump the support envelope grouped by capability (default) or provider.")
  .option("--by-capability", "Group by capability family (default).")
  .option("--by-provider", "Group by provider.")
  .action(async (opts: { byCapability?: boolean; byProvider?: boolean }) => {
    await registry.discover();
    printJson(opts.byProvider ? registry.providerCatalog() : registry.capabilityCatalog());
  });

// ---- envelope (full support envelope — the firehose) -----------------------
program
  .command("envelope")
  .description("Print the full support envelope (every tool's contract + live status).")
  .action(async () => {
    await registry.discover();
    printJson(registry.supportEnvelope());
  });

// ---- runtimes ---------------------------------------------------------------
program
  .command("runtimes")
  .description("Report availability of the three composition runtimes (ffmpeg/remotion/hyperframes).")
  .action(async () => {
    await registry.discover();
    const info = registry.get("video_compose")?.getInfo() ?? {};
    printJson({
      render_engines: info.render_engines ?? null,
      remotion_note: info.remotion_note ?? null,
      hyperframes_note: info.hyperframes_note ?? null,
    });
  });

// ---- demo (the FREE, zero-key flow) -----------------------------------------
program
  .command("demo")
  .description("Render the curated zero-key Remotion demos (no API keys required).")
  .argument("[name]", "Render one named demo instead of all demos.")
  .option("--list", "List available demo fixtures and exit.")
  .action(async (name: string | undefined, opts: { list?: boolean }) => {
    // Lazy-import the Remotion module so non-demo commands don't load the renderer.
    const { listDemos, renderDemo, renderAllDemos } = await import("../remotion/render.js");

    const demos = listDemos();
    if (demos.length === 0) {
      console.error("Error: No demo prop files were found.");
      process.exit(1);
    }

    if (opts.list) {
      console.log("Available zero-key demos:");
      for (const d of demos) {
        console.log(`  ${d.name.padEnd(20)} ${d.description}`);
      }
      return;
    }

    if (name && !demos.some((d) => d.name === name)) {
      console.error(`Unknown demo '${name}'. Available demos: ${demos.map((d) => d.name).join(", ")}`);
      process.exit(1);
    }

    const results = name ? [await renderDemo(name)] : await renderAllDemos();
    for (const r of results) {
      const sizeMb = (r.sizeBytes / (1024 * 1024)).toFixed(1);
      console.log(
        `Done: ${r.outputPath} (${sizeMb} MB, ${r.width}x${r.height}@${r.fps}, ${r.durationInFrames} frames, ${r.codec})`
      );
    }
  });

// ---- hyperframes <doctor|warm> ----------------------------------------------
program
  .command("hyperframes")
  .description("HyperFrames runtime helpers.")
  .argument("<action>", "doctor | warm")
  .action(async (action: string) => {
    if (action === "warm") {
      console.log("==> Refreshing the HyperFrames npx cache to latest...");
      await execa("npx", ["--yes", "--prefer-online", "hyperframes", "--version"], { stdio: "inherit" });
      return;
    }
    if (action === "doctor") {
      const floor = {
        node: process.version,
        node_ok: Number(process.versions.node.split(".")[0]) >= 22,
        ffmpeg: commandExists("ffmpeg"),
        npx: commandExists("npx"),
      };
      let hyperframes_doctor: unknown = null;
      try {
        const { stdout } = await execa("npx", ["--yes", "hyperframes", "doctor"], { timeout: 120000 });
        hyperframes_doctor = stdout;
      } catch (err) {
        hyperframes_doctor = `unavailable: ${(err as Error).message}`;
      }
      printJson({ runtime_floor: floor, hyperframes_doctor });
      return;
    }
    console.error(`Unknown hyperframes action '${action}'. Use: doctor | warm`);
    process.exit(1);
  });

// ---- run <tool> --params <json> ---------------------------------------------
program
  .command("run")
  .description("Execute a registered tool with JSON params.")
  .argument("<tool>", "Tool name (see `montagent catalog`).")
  .requiredOption("--params <json>", "JSON object of tool inputs.")
  .action(async (toolName: string, opts: { params: string }) => {
    await registry.discover();
    const tool = registry.get(toolName);
    if (!tool) {
      console.error(`Unknown tool: ${toolName}. See \`montagent catalog\`.`);
      process.exit(1);
    }
    let params: Record<string, unknown>;
    try {
      params = JSON.parse(opts.params);
    } catch (err) {
      console.error(`--params is not valid JSON: ${(err as Error).message}`);
      process.exit(1);
      return;
    }
    const result = await tool.execute(params);
    printJson(result);
    if (!result.success) process.exit(1);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
