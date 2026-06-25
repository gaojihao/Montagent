/**
 * Shared capability-selector base (factored from the four Python selector tools:
 * tts_selector / image_selector / video_selector / screen_capture_selector).
 *
 * All four implement identical routing: auto-discover providers of a capability
 * from the registry, rank them via lib/scoring, honor preferred/allowed providers,
 * delegate to the chosen provider's execute(), and support a "rank" operation.
 * Subclasses only set contract fields + the prompt extractor.
 */
import {
  BaseTool,
  type ToolResult,
  ToolRuntime,
  ToolStability,
  ToolStatus,
  ToolTier,
  toolResult,
} from "./base_tool.js";
import { registry } from "./tool_registry.js";
import { normalizeTaskContext, rankProviders, type ProviderScore } from "../lib/scoring.js";

export abstract class BaseSelector extends BaseTool {
  override provider = "selector";
  override stability = ToolStability.BETA;
  override runtime = ToolRuntime.HYBRID;

  /** Which input field carries the natural-language prompt (for scoring). */
  protected promptField = "prompt";

  protected promptFromInputs(inputs: Record<string, unknown>): string {
    return (inputs[this.promptField] as string) ?? "";
  }

  /** Auto-discover sibling providers of this capability (excluding self). */
  protected async providers(): Promise<BaseTool[]> {
    await registry.discover();
    return registry.getByCapability(this.capability).filter((t) => t.name !== this.name);
  }

  override getStatus(): ToolStatus {
    // Sync check: registry must already be discovered (CLI/caller awaits discover()).
    const peers = registry.getByCapability(this.capability).filter((t) => t.name !== this.name);
    return peers.some((t) => t.getStatus() === ToolStatus.AVAILABLE)
      ? ToolStatus.AVAILABLE
      : ToolStatus.UNAVAILABLE;
  }

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const taskContext = this.prepareTaskContext(inputs);
    const candidates = await this.providers();

    if (inputs.operation === "rank") {
      const rankings = rankProviders(candidates, taskContext);
      return toolResult({
        success: true,
        data: {
          rankings: this.serializeRankings(candidates, rankings),
          explanation: rankings.slice(0, 5).map((r) => r.explain()).join("\n"),
          normalized_task_context: taskContext,
        },
      });
    }

    const { tool, score } = this.selectBestTool(inputs, candidates, taskContext);
    if (!tool) {
      return toolResult({ success: false, error: `No ${this.capability} provider available.` });
    }

    const result = await tool.execute(inputs);
    if (result.success) {
      result.data = result.data ?? {};
      if (!("selected_tool" in result.data)) result.data.selected_tool = tool.name;
      result.data.selected_provider = tool.provider;
      result.data.selection_reason = score ? score.explain() : `Selected ${tool.provider} (${tool.name})`;
      if (score) result.data.provider_score = score.toDict();
      Object.assign(result.data, this.toolContextPayload(tool));
      result.data.alternatives_considered = candidates
        .filter((t) => t.name !== tool.name && t.getStatus() === ToolStatus.AVAILABLE)
        .map((t) => t.name);
    }
    return result;
  }

  protected selectBestTool(
    inputs: Record<string, unknown>,
    candidatesIn: BaseTool[],
    taskContext: Record<string, unknown>
  ): { tool: BaseTool | null; score: ProviderScore | null } {
    const preferred = (inputs.preferred_provider as string) ?? "auto";
    const allowed = new Set((inputs.allowed_providers as string[]) ?? []);
    let candidates = candidatesIn;
    if (allowed.size > 0) candidates = candidates.filter((t) => allowed.has(t.provider));

    const rankings = rankProviders(candidates, taskContext);
    const toolByProvider = new Map<string, BaseTool>();
    for (const tool of candidates) {
      if (!toolByProvider.has(tool.provider) && tool.getStatus() === ToolStatus.AVAILABLE) {
        toolByProvider.set(tool.provider, tool);
      }
    }

    if (preferred !== "auto") {
      for (const s of rankings) {
        if (s.provider === preferred && toolByProvider.has(s.provider)) {
          return { tool: toolByProvider.get(s.provider)!, score: s };
        }
      }
    }
    for (const s of rankings) {
      if (toolByProvider.has(s.provider)) return { tool: toolByProvider.get(s.provider)!, score: s };
    }
    return { tool: null, score: null };
  }

  protected prepareTaskContext(inputs: Record<string, unknown>): Record<string, unknown> {
    return normalizeTaskContext((inputs.task_context as Record<string, unknown>) ?? {}, {
      prompt: this.promptFromInputs(inputs),
      capability: this.capability,
      operation: (inputs.operation as string) ?? "generate",
    });
  }

  protected toolContextPayload(tool: BaseTool): Record<string, unknown> {
    const info = tool.getInfo();
    return {
      selected_tool_agent_skills: info.agent_skills ?? [],
      required_agent_skills: info.agent_skills ?? [],
      selected_tool_usage_location: info.usage_location,
      selected_tool_best_for: info.best_for ?? [],
    };
  }

  protected serializeRankings(candidates: BaseTool[], rankings: ProviderScore[]): Array<Record<string, unknown>> {
    const byName = new Map(candidates.map((t) => [t.name, t]));
    return rankings.map((score) => {
      const item: Record<string, unknown> = score.toDict();
      const tool = byName.get(score.tool_name);
      if (tool) {
        const info = tool.getInfo();
        item.agent_skills = info.agent_skills ?? [];
        item.usage_location = info.usage_location;
        item.best_for = info.best_for ?? [];
        item.status = tool.getStatus();
      }
      return item;
    });
  }
}
