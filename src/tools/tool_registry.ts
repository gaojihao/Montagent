/**
 * Tool registry with status, stability, and support-envelope reporting.
 *
 * TypeScript port of tools/tool_registry.py. The registry discovers all
 * registered tools, reports their availability, and lets the orchestrator/
 * agents query capabilities by tier, status, etc.
 *
 * Parity notes vs. Python:
 *  - discover() REPLACES pkgutil/inspect reflection: it instantiates every
 *    class in ALL_TOOLS (from ./index.js) and registers each. Idempotent.
 *  - Method names are camelCase; behavior + JSON shapes match Python verbatim
 *    (this output is diff-tested against Python at acceptance).
 *  - Object key ordering mirrors Python: grouped catalogs are returned with
 *    keys sorted (dict(sorted(...))); insertion order is otherwise preserved.
 *  - _scrubUnicodeDashes mirrors _scrub_unicode_dashes (keeps output ASCII-clean).
 */
import {
  BaseTool,
  ToolStatus,
  ToolTier,
  ToolStability,
} from "./base_tool.js";
import { ALL_TOOLS } from "./index.js";

// Unicode punctuation that breaks on Windows cp1252 stdout. Map each to an
// ASCII equivalent. This only touches strings rendered by registry helpers
// that an agent is likely to print to the user at preflight.
const UNICODE_DASH_REPLACEMENTS: Array<[string, string]> = [
  ["—", "--"], // em dash
  ["–", "-"], // en dash
  ["−", "-"], // minus sign
  ["‘", "'"], // left single quote
  ["’", "'"], // right single quote
  ["“", '"'], // left double quote
  ["”", '"'], // right double quote
  ["…", "..."], // ellipsis
];

/**
 * Recursively normalize unicode punctuation in string leaves to ASCII.
 * Used to keep providerMenuSummary() output readable on Windows cp1252 stdout.
 * Does NOT modify object/array structure or non-string values.
 */
function scrubUnicodeDashes<T>(value: T): T {
  if (typeof value === "string") {
    let out = value as string;
    for (const [needle, repl] of UNICODE_DASH_REPLACEMENTS) {
      if (out.includes(needle)) out = out.split(needle).join(repl);
    }
    return out as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubUnicodeDashes(item)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = scrubUnicodeDashes(v);
    }
    return result as unknown as T;
  }
  return value;
}

/** Compare two strings the way Python tuple-sorts string keys (codepoint order). */
function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Compare by (provider, name) like the Python sort keys. */
function cmpProviderName(
  a: { provider?: string; name?: string },
  b: { provider?: string; name?: string }
): number {
  const p = cmpStr(a.provider ?? "", b.provider ?? "");
  return p !== 0 ? p : cmpStr(a.name ?? "", b.name ?? "");
}

/** Compare by (capability, name) like the Python sort keys. */
function cmpCapabilityName(
  a: { capability?: string; name?: string },
  b: { capability?: string; name?: string }
): number {
  const c = cmpStr(a.capability ?? "", b.capability ?? "");
  return c !== 0 ? c : cmpStr(a.name ?? "", b.name ?? "");
}

/** Return a new object with keys sorted ascending (mirrors dict(sorted(...))). */
function sortObjectByKey<V>(obj: Record<string, V>): Record<string, V> {
  const sorted: Record<string, V> = {};
  for (const key of Object.keys(obj).sort(cmpStr)) {
    sorted[key] = obj[key]!;
  }
  return sorted;
}

interface CapabilityRollup {
  capability: string;
  configured: number;
  total: number;
  available_providers: string[];
  unavailable_providers: string[];
}

interface SetupOffer {
  capability: string;
  tool: string | undefined;
  provider: string | undefined;
  install_instructions: string;
}

export interface ProviderMenuSummary {
  composition_runtimes: Record<string, boolean>;
  capabilities: CapabilityRollup[];
  setup_offers: SetupOffer[];
  runtime_warnings: string[];
}

/** Central registry of all Montagent tools. */
export class ToolRegistry {
  private _tools: Map<string, BaseTool> = new Map();
  private _discovered = false;

  /** Register a tool instance. */
  register(tool: BaseTool): void {
    if (!tool.name) {
      throw new Error("Tool must have a non-empty name");
    }
    this._tools.set(tool.name, tool);
  }

  /** Clear registered tools and discovery state. */
  clear(): void {
    this._tools.clear();
    this._discovered = false;
  }

  /**
   * Instantiate every class in ALL_TOOLS, register each, and return their
   * names. Idempotent — repeated calls do not re-register. This REPLACES
   * Python's pkgutil package-walk with the explicit index.
   */
  async discover(): Promise<string[]> {
    if (this._discovered) {
      return this.listAll();
    }
    const discovered: string[] = [];
    for (const ToolClass of ALL_TOOLS) {
      const tool = new ToolClass();
      this.register(tool);
      discovered.push(tool.name);
    }
    this._discovered = true;
    return discovered;
  }

  /** Load tool classes once before reporting capabilities. */
  private ensureDiscovered(): void {
    if (!this._discovered) {
      for (const ToolClass of ALL_TOOLS) {
        this.register(new ToolClass());
      }
      this._discovered = true;
    }
  }

  /** Get a tool by name. */
  get(name: string): BaseTool | undefined {
    return this._tools.get(name);
  }

  /** List all registered tool names. */
  listAll(): string[] {
    return [...this._tools.keys()];
  }

  private values(): BaseTool[] {
    return [...this._tools.values()];
  }

  /** Get all tools in a given tier. */
  getByTier(tier: ToolTier): BaseTool[] {
    return this.values().filter((t) => t.tier === tier);
  }

  /** Get all tools registered for a top-level capability family. */
  getByCapability(capability: string): BaseTool[] {
    return this.values().filter((t) => t.capability === capability);
  }

  /** Get all tools backed by a specific provider. */
  getByProvider(provider: string): BaseTool[] {
    return this.values().filter((t) => t.provider === provider);
  }

  /** Get all tools with a given status. */
  getByStatus(status: ToolStatus): BaseTool[] {
    return this.values().filter((t) => t.getStatus() === status);
  }

  /** Get all tools that are currently available. */
  getAvailable(): BaseTool[] {
    return this.getByStatus(ToolStatus.AVAILABLE);
  }

  /** Get all tools that are currently unavailable. */
  getUnavailable(): BaseTool[] {
    return this.getByStatus(ToolStatus.UNAVAILABLE);
  }

  /** Get all tools at a given stability level. */
  getByStability(stability: ToolStability): BaseTool[] {
    return this.values().filter((t) => t.stability === stability);
  }

  /** Find tools that declare a given capability. */
  findByCapability(capability: string): BaseTool[] {
    return this.values().filter((t) => t.capabilities.includes(capability));
  }

  /** Find the fallback tool for a given tool, if declared and available. */
  findFallback(toolName: string): BaseTool | undefined {
    const tool = this.get(toolName);
    if (tool === undefined) return undefined;
    const candidates = [...(tool.fallback_tools ?? [])];
    if (tool.fallback && !candidates.includes(tool.fallback)) {
      candidates.push(tool.fallback);
    }
    for (const name of candidates) {
      const fb = this.get(name);
      if (fb && fb.getStatus() === ToolStatus.AVAILABLE) {
        return fb;
      }
    }
    return undefined;
  }

  /**
   * Generate a full support-envelope report for all tools.
   * Returns an object mapping tool name to its contract info + live status.
   */
  supportEnvelope(): Record<string, Record<string, unknown>> {
    this.ensureDiscovered();
    const report: Record<string, Record<string, unknown>> = {};
    for (const [name, tool] of this._tools) {
      report[name] = tool.getInfo();
    }
    return report;
  }

  /** Group the support envelope by top-level capability (keys sorted). */
  capabilityCatalog(): Record<string, Array<Record<string, unknown>>> {
    this.ensureDiscovered();
    const grouped: Record<string, Array<Record<string, unknown>>> = {};
    for (const tool of this.values()) {
      const info = tool.getInfo();
      (grouped[tool.capability] ??= []).push(info);
    }
    for (const items of Object.values(grouped)) {
      items.sort((a, b) =>
        cmpProviderName(
          a as { provider?: string; name?: string },
          b as { provider?: string; name?: string }
        )
      );
    }
    return sortObjectByKey(grouped);
  }

  /** Group the support envelope by provider (keys sorted). */
  providerCatalog(): Record<string, Array<Record<string, unknown>>> {
    this.ensureDiscovered();
    const grouped: Record<string, Array<Record<string, unknown>>> = {};
    for (const tool of this.values()) {
      const info = tool.getInfo();
      (grouped[tool.provider] ??= []).push(info);
    }
    for (const items of Object.values(grouped)) {
      items.sort((a, b) =>
        cmpCapabilityName(
          a as { capability?: string; name?: string },
          b as { capability?: string; name?: string }
        )
      );
    }
    return sortObjectByKey(grouped);
  }

  /**
   * Summarize tool counts by tier and status.
   * Returns e.g. {"core": {"available": 5, "unavailable": 2, "degraded": 0}}.
   * Iterates tiers in enum-declaration order; only tiers with tools are kept.
   */
  tierSummary(): Record<string, Record<string, number>> {
    const summary: Record<string, Record<string, number>> = {};
    for (const tier of Object.values(ToolTier)) {
      const tierTools = this.getByTier(tier);
      const counts: Record<string, number> = {
        available: 0,
        unavailable: 0,
        degraded: 0,
      };
      for (const t of tierTools) {
        const status = t.getStatus();
        counts[status] = (counts[status] ?? 0) + 1;
      }
      if (tierTools.length > 0) {
        summary[tier] = counts;
      }
    }
    return summary;
  }

  /**
   * Generate a capability-grouped provider menu for user-facing display.
   * Skips selectors (they aggregate, they aren't providers). Buckets are
   * sorted by (provider, name) and the top-level keys are sorted.
   */
  providerMenu(): Record<string, Record<string, unknown>> {
    this.ensureDiscovered();
    const menu: Record<
      string,
      {
        available: Array<Record<string, unknown>>;
        unavailable: Array<Record<string, unknown>>;
        total: number;
        configured: number;
      }
    > = {};

    // Skip selectors — they aggregate, they aren't providers themselves.
    const tools = this.values().filter((t) => t.provider !== "selector");

    for (const tool of tools) {
      const cap = tool.capability;
      if (!(cap in menu)) {
        menu[cap] = {
          available: [],
          unavailable: [],
          total: 0,
          configured: 0,
        };
      }

      const info = tool.getInfo();
      const status = tool.getStatus();
      const entry: Record<string, unknown> = {
        name: tool.name,
        provider: tool.provider,
        runtime: tool.runtime,
        best_for: tool.best_for,
        install_instructions: tool.install_instructions,
        status: status,
      };
      for (const extraKey of [
        "source_provider_menu",
        "source_provider_summary",
        "render_engines",
        "remotion_note",
        "provider_matrix",
      ]) {
        if (Object.prototype.hasOwnProperty.call(info, extraKey)) {
          entry[extraKey] = info[extraKey];
        }
      }

      const bucket = menu[cap]!;
      if (status === ToolStatus.AVAILABLE) {
        bucket.available.push(entry);
        bucket.configured += 1;
      } else {
        bucket.unavailable.push(entry);
      }
      bucket.total += 1;
    }

    for (const bucket of Object.values(menu)) {
      bucket.available.sort((a, b) =>
        cmpProviderName(
          a as { provider?: string; name?: string },
          b as { provider?: string; name?: string }
        )
      );
      bucket.unavailable.sort((a, b) =>
        cmpProviderName(
          a as { provider?: string; name?: string },
          b as { provider?: string; name?: string }
        )
      );
    }

    return sortObjectByKey(menu) as Record<string, Record<string, unknown>>;
  }

  /**
   * Compact, human-ready rollup of providerMenu() for onboarding/preflight.
   * Returns {composition_runtimes, capabilities[], setup_offers[],
   * runtime_warnings[]}, scrubbed to ASCII-clean strings.
   */
  providerMenuSummary(): ProviderMenuSummary {
    this.ensureDiscovered();
    const menu = this.providerMenu();

    // Composition runtimes — lift from video_compose.getInfo() since they're
    // the signal the runtime-selection contract depends on.
    let compRuntimes: Record<string, boolean> = {};
    const runtimeWarnings: string[] = [];
    const vc = this._tools.get("video_compose");
    if (vc !== undefined) {
      const info = vc.getInfo();
      const engines = (info.render_engines as Record<string, unknown>) ?? {};
      compRuntimes = {};
      for (const [k, v] of Object.entries(engines)) {
        compRuntimes[k] = Boolean(v);
      }
    }
    // If hyperframes_compose is registered, surface its npm-resolve reasons.
    const hf = this._tools.get("hyperframes_compose");
    if (hf !== undefined) {
      const hfInfo = hf.getInfo();
      const rc =
        (hfInfo.hyperframes_runtime as Record<string, unknown>) ?? {};
      const reasons = (rc.reasons as string[]) ?? [];
      for (const reason of reasons) {
        runtimeWarnings.push(`hyperframes: ${reason}`);
      }
    }

    // Capabilities rollup (configured/total + provider lists).
    // Dedupe: a provider with any available tool must NOT appear as unavailable.
    const capabilities: CapabilityRollup[] = [];
    for (const [cap, bucketRaw] of Object.entries(menu)) {
      const bucket = bucketRaw as {
        available?: Array<Record<string, unknown>>;
        unavailable?: Array<Record<string, unknown>>;
        configured?: number;
        total?: number;
      };
      const availableProviders = new Set<string>();
      for (const e of bucket.available ?? []) {
        const p = e.provider as string | undefined;
        if (p !== undefined && p !== null) availableProviders.add(p);
      }
      const unavailableProviders = new Set<string>();
      for (const e of bucket.unavailable ?? []) {
        const p = e.provider as string | undefined;
        if (p !== undefined && p !== null && !availableProviders.has(p)) {
          unavailableProviders.add(p);
        }
      }
      capabilities.push({
        capability: cap,
        configured: bucket.configured ?? 0,
        total: bucket.total ?? 0,
        available_providers: [...availableProviders].sort(cmpStr),
        unavailable_providers: [...unavailableProviders].sort(cmpStr),
      });
    }

    // Setup offers — unavailable tools that would be 1-minute env-var fixes.
    const setupOffers: SetupOffer[] = [];
    for (const [cap, bucketRaw] of Object.entries(menu)) {
      const bucket = bucketRaw as {
        unavailable?: Array<Record<string, unknown>>;
      };
      for (const entry of bucket.unavailable ?? []) {
        const hint = (entry.install_instructions as string) ?? "";
        const lower = hint.toLowerCase();
        if (
          ["api key", "env", "_key=", "_api"].some((k) => lower.includes(k))
        ) {
          setupOffers.push({
            capability: cap,
            tool: entry.name as string | undefined,
            provider: entry.provider as string | undefined,
            install_instructions: hint,
          });
        }
      }
    }

    const result: ProviderMenuSummary = {
      composition_runtimes: compRuntimes,
      capabilities,
      setup_offers: setupOffers,
      runtime_warnings: runtimeWarnings,
    };
    // Normalize unicode dashes/quotes to ASCII so preflight prints cleanly on
    // Windows cp1252 stdout. Only touches the runtime-reported strings.
    return scrubUnicodeDashes(result);
  }

  /** List tools that require GPU (VRAM > 0). */
  gpuRequiredTools(): string[] {
    return this.values()
      .filter((t) => t.resource_profile.vram_mb > 0)
      .map((t) => t.name);
  }

  /** List tools that require network access. */
  networkRequiredTools(): string[] {
    return this.values()
      .filter((t) => t.resource_profile.network_required)
      .map((t) => t.name);
  }
}

// Singleton registry instance
export const registry = new ToolRegistry();
