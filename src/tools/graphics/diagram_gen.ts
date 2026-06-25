/**
 * Diagram generation tool using the Mermaid CLI or canvas-rendered box/arrow diagrams.
 *
 * TypeScript port of tools/graphics/diagram_gen.py. Generates technical diagrams
 * from text descriptions: Mermaid syntax (flowcharts, sequence diagrams, etc.)
 * rendered via the Mermaid CLI, and simple box/arrow diagrams rendered locally.
 *
 * Parity notes vs. Python:
 *  - Mermaid: Python shells out to the `mmdc` binary (mermaid-cli). The TS port
 *    keeps that behavior but is more robust about discovery — it uses `mmdc`
 *    directly when on PATH (commandExists("mmdc")), otherwise invokes the same
 *    CLI via `npx --yes @mermaid-js/mermaid-cli` (npx is always available in the
 *    Node toolchain). The CLI argument vector is identical to the Python one
 *    (-i input.mmd, -o output, -c config.json with {theme}, -b transparent,
 *    -w width), as is the temp `.mmd` / `.mermaid.json` write+unlink lifecycle.
 *  - Pillow is replaced by @napi-rs/canvas (the established Pillow replacement in
 *    this codebase). The box-diagram grid layout math, theme color palettes,
 *    rounded rectangles, connection lines + arrow-head polygons, connection
 *    labels, and the text-card fallback are ported verbatim (PIL .save -> canvas
 *    PNG buffer written to disk). Because canvas is bundled, the box/boxes and
 *    text-card paths are always available (no "Pillow required" error path is
 *    reachable, matching an environment where Pillow is installed).
 *  - dependencies = [] (checked dynamically), matching the Python contract.
 *  - get_status() returns AVAILABLE (mermaid CLI reachable via npx OR local
 *    canvas rendering available — mirrors Python's `_has_mermaid() or
 *    _has_pillow()`).
 */
import fs from "node:fs";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import {
  BaseTool,
  Determinism,
  ExecutionMode,
  ResourceProfile,
  ToolResult,
  ToolStability,
  ToolStatus,
  ToolTier,
  commandExists,
  toolResult,
} from "../base_tool.js";

export class DiagramGen extends BaseTool {
  override name = "diagram_gen";
  override version = "0.1.0";
  override tier = ToolTier.CORE;
  override capability = "graphics";
  override provider = "mermaid";
  override stability = ToolStability.EXPERIMENTAL;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;

  override dependencies = []; // checked dynamically
  override install_instructions =
    "For Mermaid diagrams:\n" +
    "  npm install -g @mermaid-js/mermaid-cli\n" +
    "  (or rely on the bundled `npx --yes @mermaid-js/mermaid-cli`)\n" +
    "Box/text diagrams use the bundled @napi-rs/canvas — no install needed.";
  override agent_skills = ["beautiful-mermaid", "d3-viz"];

  override capabilities = [
    "generate_mermaid",
    "generate_flowchart",
    "generate_box_diagram",
  ];

  override input_schema = {
    type: "object",
    required: ["diagram_type"],
    properties: {
      diagram_type: {
        type: "string",
        enum: ["mermaid", "flowchart", "boxes"],
      },
      definition: {
        type: "string",
        description: "Mermaid syntax or diagram description",
      },
      boxes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            color: { type: "string" },
          },
        },
        description: "Box definitions for box diagram type",
      },
      connections: {
        type: "array",
        items: {
          type: "object",
          properties: {
            from: { type: "integer" },
            to: { type: "integer" },
            label: { type: "string" },
          },
        },
      },
      title: { type: "string" },
      theme: {
        type: "string",
        enum: ["dark", "light", "neutral"],
        default: "dark",
      },
      width: { type: "integer", default: 1200 },
      height: { type: "integer", default: 800 },
      output_path: { type: "string" },
    },
  };

  override resource_profile: ResourceProfile = {
    cpu_cores: 1,
    ram_mb: 256,
    vram_mb: 0,
    disk_mb: 50,
    network_required: false,
  };
  override idempotency_key_fields = ["diagram_type", "definition", "boxes"];
  override side_effects = ["writes diagram image to output_path"];
  override user_visible_verification = [
    "Verify diagram accurately represents the described structure",
  ];

  override getStatus(): ToolStatus {
    if (this.hasMermaid() || this.hasCanvas()) {
      return ToolStatus.AVAILABLE;
    }
    return ToolStatus.UNAVAILABLE;
  }

  /** Mermaid is renderable when mmdc is on PATH or npx can fetch it. */
  private hasMermaid(): boolean {
    return commandExists("mmdc") || commandExists("npx");
  }

  /** Canvas (the Pillow replacement) is bundled, so box/text rendering is always available. */
  private hasCanvas(): boolean {
    return true;
  }

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const diagramType = inputs.diagram_type as string;
    const start = Date.now();

    let result: ToolResult;
    try {
      if (diagramType === "mermaid") {
        result = await this.renderMermaid(inputs);
      } else if (diagramType === "flowchart" || diagramType === "boxes") {
        result = this.renderBoxes(inputs);
      } else {
        return toolResult({
          success: false,
          error: `Unknown diagram type: ${diagramType}`,
        });
      }
    } catch (e) {
      return toolResult({
        success: false,
        error: `Diagram generation failed: ${(e as Error).message ?? e}`,
      });
    }

    result.duration_seconds = Math.round((Date.now() - start) / 10) / 100;
    return result;
  }

  private async renderMermaid(
    inputs: Record<string, unknown>
  ): Promise<ToolResult> {
    const definition = (inputs.definition as string) ?? "";
    if (!definition) {
      return toolResult({
        success: false,
        error: "Mermaid definition required",
      });
    }

    const outputPath = (inputs.output_path as string) ?? "diagram.png";
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    const theme = (inputs.theme as string) ?? "dark";

    if (this.hasMermaid()) {
      // Write temp mermaid file (sibling of output, like output_path.with_suffix).
      const tempMmd = this.withSuffix(outputPath, ".mmd");
      fs.writeFileSync(tempMmd, definition, { encoding: "utf-8" });

      const mermaidConfig = { theme };
      const configPath = this.withSuffix(outputPath, ".mermaid.json");
      fs.writeFileSync(configPath, JSON.stringify(mermaidConfig), {
        encoding: "utf-8",
      });

      // Prefer the local mmdc binary; otherwise invoke the same CLI via npx.
      const cliPrefix = commandExists("mmdc")
        ? ["mmdc"]
        : ["npx", "--yes", "@mermaid-js/mermaid-cli"];

      const cmd = [
        ...cliPrefix,
        "-i",
        tempMmd,
        "-o",
        outputPath,
        "-c",
        configPath,
        "-b",
        "transparent",
        "-w",
        String((inputs.width as number) ?? 1200),
      ];

      try {
        await this.runCommand(cmd, { timeout: 30_000 });
      } finally {
        this.unlinkMissingOk(tempMmd);
        this.unlinkMissingOk(configPath);
      }

      return toolResult({
        success: true,
        data: {
          method: "mermaid-cli",
          output: outputPath,
        },
        artifacts: [outputPath],
      });
    } else {
      // Fallback: render mermaid text as a styled text card
      return this.renderTextCard(definition, inputs);
    }
  }

  /** Render a box-and-arrow diagram using canvas (Pillow replacement). */
  private renderBoxes(inputs: Record<string, unknown>): ToolResult {
    let boxes = (inputs.boxes as Array<Record<string, unknown>>) ?? [];
    const connections =
      (inputs.connections as Array<Record<string, unknown>>) ?? [];
    const title = (inputs.title as string) ?? "";
    const theme = (inputs.theme as string) ?? "dark";
    const width = (inputs.width as number) ?? 1200;
    const height = (inputs.height as number) ?? 800;
    const outputPath = (inputs.output_path as string) ?? "diagram.png";
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });

    // Theme colors
    let bg: string,
      textColor: string,
      boxDefault: string,
      lineColor: string;
    if (theme === "dark") {
      bg = "#1e1e2e";
      textColor = "#cdd6f4";
      boxDefault = "#45475a";
      lineColor = "#89b4fa";
    } else if (theme === "light") {
      bg = "#ffffff";
      textColor = "#333333";
      boxDefault = "#e1e4e8";
      lineColor = "#0366d6";
    } else {
      bg = "#2d2d2d";
      textColor = "#d4d4d4";
      boxDefault = "#404040";
      lineColor = "#569cd6";
    }

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    // Pillow's truetype("arial.ttf", N) -> canvas sans-serif at N px.
    const fontSpec = (size: number) => `${size}px Arial, sans-serif`;

    // Draw title (textbbox-centered like the Python).
    let yOffset = 20;
    if (title) {
      ctx.font = fontSpec(24);
      const tw = this.textWidth(ctx, title);
      ctx.fillStyle = textColor;
      // PIL draw.text((x, y), ...) anchors at the text's top-left; canvas uses
      // the baseline by default, so set textBaseline="top" to match.
      ctx.textBaseline = "top";
      ctx.fillText(title, Math.trunc((width - tw) / 2), yOffset);
      yOffset += 50;
    }

    // Layout boxes in a grid
    if (boxes.length === 0) {
      boxes = [{ label: "Empty" }];
    }

    const cols = Math.min(boxes.length, 4);
    const rows = Math.trunc((boxes.length + cols - 1) / cols);
    const boxW = Math.min(200, Math.trunc((width - 80) / cols) - 20);
    const boxH = 60;
    const xGap = Math.trunc((width - cols * boxW) / (cols + 1));
    const yGap = Math.max(
      40,
      Math.trunc((height - yOffset - rows * boxH) / (rows + 1))
    );

    const boxPositions: Array<[number, number, number, number]> = [];
    ctx.font = fontSpec(18);
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i]!;
      const col = i % cols;
      const row = Math.trunc(i / cols);
      const x = xGap + col * (boxW + xGap);
      const y = yOffset + yGap + row * (boxH + yGap);

      const fill = (box.color as string) ?? boxDefault;
      // PIL rounded_rectangle(fill, outline, width=2, radius=8).
      ctx.beginPath();
      ctx.roundRect(x, y, boxW, boxH, 8);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = lineColor;
      ctx.stroke();

      const label = (box.label as string) ?? `Box ${i}`;
      const metrics = ctx.measureText(label);
      const lw = metrics.width;
      // PIL textbbox height = ascent + descent of the actual glyphs.
      const lh =
        metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent;
      ctx.fillStyle = textColor;
      ctx.textBaseline = "top";
      ctx.fillText(
        label,
        x + Math.trunc((boxW - lw) / 2),
        y + Math.trunc((boxH - lh) / 2)
      );

      boxPositions.push([x, y, x + boxW, y + boxH]);
    }

    // Draw connections
    for (const conn of connections) {
      const fi = (conn.from as number) ?? 0;
      const ti = (conn.to as number) ?? 0;
      if (fi >= boxPositions.length || ti >= boxPositions.length) {
        continue;
      }

      const [fx1, , fx2, fy2] = boxPositions[fi]!;
      const [tx1, ty1, tx2] = boxPositions[ti]!;

      const startX = Math.trunc((fx1 + fx2) / 2);
      const startY = fy2;
      const endX = Math.trunc((tx1 + tx2) / 2);
      const endY = ty1;

      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.lineTo(endX, endY);
      ctx.lineWidth = 2;
      ctx.strokeStyle = lineColor;
      ctx.stroke();

      // Arrow head
      const arrowSize = 8;
      ctx.beginPath();
      ctx.moveTo(endX, endY);
      ctx.lineTo(endX - arrowSize, endY - arrowSize * 2);
      ctx.lineTo(endX + arrowSize, endY - arrowSize * 2);
      ctx.closePath();
      ctx.fillStyle = lineColor;
      ctx.fill();

      // Connection label
      const connLabel = conn.label as string | undefined;
      if (connLabel) {
        const midX = Math.trunc((startX + endX) / 2);
        const midY = Math.trunc((startY + endY) / 2);
        ctx.font = fontSpec(18);
        ctx.fillStyle = textColor;
        ctx.textBaseline = "top";
        ctx.fillText(connLabel, midX + 5, midY - 10);
      }
    }

    fs.writeFileSync(outputPath, canvas.toBuffer("image/png"));

    return toolResult({
      success: true,
      data: {
        method: "pillow",
        output: outputPath,
        box_count: boxes.length,
        connection_count: connections.length,
      },
      artifacts: [outputPath],
    });
  }

  /** Fallback: render text as a styled card image. */
  private renderTextCard(
    text: string,
    inputs: Record<string, unknown>
  ): ToolResult {
    const outputPath = (inputs.output_path as string) ?? "diagram.png";
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    const width = (inputs.width as number) ?? 800;

    // Calculate needed height
    const lines = text.split("\n");
    const lineHeight = 22;
    const height = Math.max(200, lines.length * lineHeight + 80);

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#1e1e2e";
    ctx.fillRect(0, 0, width, height);

    // PIL truetype("consola.ttf", 16) -> monospace at 16px.
    ctx.font = "16px Consolas, monospace";
    ctx.fillStyle = "#cdd6f4";
    ctx.textBaseline = "top";

    let y = 40;
    for (const line of lines) {
      ctx.fillText(line, 40, y);
      y += lineHeight;
    }

    fs.writeFileSync(outputPath, canvas.toBuffer("image/png"));

    return toolResult({
      success: true,
      data: {
        method: "text_card",
        output: outputPath,
      },
      artifacts: [outputPath],
    });
  }

  static listThemes(): Record<string, string> {
    return { dark: "dark", light: "light", neutral: "neutral" };
  }

  // --- helpers ---

  /** Python Path.with_suffix: replace the final extension with `suffix`. */
  private withSuffix(p: string, suffix: string): string {
    const dir = path.dirname(p);
    const base = path.basename(p);
    const ext = path.extname(base);
    const stem = ext ? base.slice(0, -ext.length) : base;
    return path.join(dir, stem + suffix);
  }

  /** Path.unlink(missing_ok=True). */
  private unlinkMissingOk(p: string): void {
    try {
      fs.unlinkSync(p);
    } catch {
      /* missing_ok */
    }
  }

  /** PIL textbbox width = right - left of the rendered glyphs. */
  private textWidth(
    ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>,
    text: string
  ): number {
    return ctx.measureText(text).width;
  }
}
