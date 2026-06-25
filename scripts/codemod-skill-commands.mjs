#!/usr/bin/env node
/**
 * Codemod: replace embedded `python -c "...registry..."` commands in the
 * instruction layer (skills/, .agents/skills/, AGENT_GUIDE.md, PROJECT_CONTEXT.md)
 * with their `montagent` CLI equivalents. Idempotent; run after the TS port.
 *
 *   registry.provider_menu_summary()  -> montagent preflight --summary
 *   registry.provider_menu()          -> montagent preflight
 *   registry.capability_catalog()     -> montagent catalog --by-capability
 *   registry.provider_catalog()       -> montagent catalog --by-provider
 *   registry.support_envelope()       -> montagent envelope
 *
 * Usage: node scripts/codemod-skill-commands.mjs [--check]
 *   --check : exit 1 if any `python -c "from tools` command remains (CI guard).
 */
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARG_DIRS = ["skills", ".agents/skills"].map((d) => path.join(ROOT, d));
const TARG_FILES = ["AGENT_GUIDE.md", "PROJECT_CONTEXT.md"].map((f) => path.join(ROOT, f));

// Order matters: provider_menu_summary must be tested before plain provider_menu.
const RULES = [
  [/render_engines/, "montagent runtimes"],
  [/provider_menu_summary/, "montagent preflight --summary"],
  [/capability_catalog/, "montagent catalog --by-capability"],
  [/provider_catalog/, "montagent catalog --by-provider"],
  [/support_envelope/, "montagent envelope"],
  [/provider_menu\b/, "montagent preflight"],
];

// Match a `python -c "..."` invocation (single- or multi-line; body has no inner ").
const PY_CMD = /python3?\s+-c\s+"[\s\S]*?"/g;

function walkMarkdown(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walkMarkdown(p));
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}

const files = [...TARG_DIRS.flatMap(walkMarkdown), ...TARG_FILES.filter(existsSync)];
const checkOnly = process.argv.includes("--check");

let changed = 0;
let remaining = 0;
const remainingFiles = [];

for (const file of files) {
  const before = readFileSync(file, "utf-8");
  const after = before.replace(PY_CMD, (m) => {
    if (!/registry/.test(m)) return m; // only rewrite registry/discovery commands
    for (const [pat, repl] of RULES) if (pat.test(m)) return repl;
    return m;
  });
  if (!checkOnly && after !== before) {
    writeFileSync(file, after, "utf-8");
    changed += 1;
  }
  // Guard scan: any leftover `python -c "from tools` is a contract violation.
  const scan = checkOnly ? before : after;
  if (/python3?\s+-c\s+"[^"]*from tools/.test(scan)) {
    remaining += 1;
    remainingFiles.push(path.relative(ROOT, file));
  }
}

if (checkOnly) {
  if (remaining > 0) {
    console.error(`CI GUARD FAILED: ${remaining} file(s) still contain \`python -c "from tools...\`:`);
    for (const f of remainingFiles) console.error("  " + f);
    process.exit(1);
  }
  console.log(`CI guard OK: no embedded \`python -c "from tools...\` commands in ${files.length} instruction files.`);
} else {
  console.log(`Codemod complete: rewrote ${changed} file(s) across ${files.length} instruction files.`);
  if (remaining > 0) {
    console.error(`WARNING: ${remaining} file(s) still contain \`python -c "from tools...\` after codemod:`);
    for (const f of remainingFiles) console.error("  " + f);
    process.exit(1);
  }
}
