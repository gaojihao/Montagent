/**
 * CI guard (plan §10): the instruction layer must not contain embedded
 * `python -c "from tools..."` commands — those break in the TypeScript port.
 * They must be rewritten to `montagent` subcommands (see scripts/codemod-skill-commands.mjs).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BANNED = /python3?\s+-c\s+"[^"]*from tools/; // [^"] crosses newlines in JS

function walkMd(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkMd(p));
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}

describe("instruction layer command parity (CI guard)", () => {
  it("contains no embedded `python -c \"from tools...\"` commands", () => {
    const files = [
      ...walkMd(path.join(ROOT, "skills")),
      ...walkMd(path.join(ROOT, ".agents/skills")),
      ...["AGENT_GUIDE.md", "PROJECT_CONTEXT.md"].map((f) => path.join(ROOT, f)).filter(existsSync),
    ];
    const offenders = files.filter((f) => BANNED.test(readFileSync(f, "utf-8")));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });
});
