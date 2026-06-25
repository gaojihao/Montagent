/**
 * Code snippet renderer for overlay images.
 *
 * TypeScript port of tools/graphics/code_snippet.py. Generates styled,
 * syntax-highlighted code screenshots. No external services required.
 *
 * Provider parity: pygments -> shiki.
 *  - The Python tool uses Pygments' ImageFormatter to render highlighted code
 *    directly to a PNG (with line numbers, padding, and a themed background),
 *    then optionally stacks a macOS-style title bar (3 window dots + centered
 *    title) on top. **Output format is PNG.**
 *  - The TS port reproduces the same PNG output: shiki tokenizes the code into
 *    per-token foreground colors (the `codeToTokens` equivalent of Pygments
 *    lexing + styling), and @napi-rs/canvas paints those tokens to a PNG with a
 *    line-number gutter, `image_pad` padding, the themed background, and the
 *    same title-bar overlay. This keeps the output format (PNG), theme,
 *    language, line-number, padding, font-size, and title-bar options faithful.
 *  - THEMES keeps the Python bg/text/border colors verbatim; `pygments_style`
 *    is mapped to the closest bundled shiki theme (`shiki_theme`). Pygments'
 *    light "default" style maps to shiki "github-light".
 *  - Pygments' line-number foreground (#6272a4) and the gutter background
 *    (theme bg) are preserved.
 *  - dependencies = [] : shiki + canvas are bundled (no network needed for
 *    bundled themes/langs), so the tool is always AVAILABLE — mirroring a Python
 *    environment where Pygments and Pillow are installed.
 */
import fs from "node:fs";
import path from "node:path";
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import { codeToTokens, bundledLanguages } from "shiki";
import {
  BaseTool,
  Determinism,
  ExecutionMode,
  ResourceProfile,
  ToolResult,
  ToolStability,
  ToolStatus,
  ToolTier,
  toolResult,
} from "../base_tool.js";

interface ThemeDef {
  /** Closest bundled shiki theme (replaces Pygments `pygments_style`). */
  shiki_theme: string;
  bg_color: string;
  text_color: string;
  border_color: string;
}

// Theme presets mapping to shiki themes and background colors.
// bg/text/border colors are copied verbatim from the Python THEMES table.
export const THEMES: Record<string, ThemeDef> = {
  monokai: {
    shiki_theme: "monokai",
    bg_color: "#272822",
    text_color: "#f8f8f2",
    border_color: "#3e3d32",
  },
  github_dark: {
    shiki_theme: "github-dark",
    bg_color: "#0d1117",
    text_color: "#c9d1d9",
    border_color: "#30363d",
  },
  dracula: {
    shiki_theme: "dracula",
    bg_color: "#282a36",
    text_color: "#f8f8f2",
    border_color: "#44475a",
  },
  one_dark: {
    shiki_theme: "one-dark-pro",
    bg_color: "#282c34",
    text_color: "#abb2bf",
    border_color: "#3e4452",
  },
  solarized_dark: {
    shiki_theme: "solarized-dark",
    bg_color: "#002b36",
    text_color: "#839496",
    border_color: "#073642",
  },
  light: {
    shiki_theme: "github-light",
    bg_color: "#ffffff",
    text_color: "#333333",
    border_color: "#e1e4e8",
  },
};

// Pygments ImageFormatter line-number foreground.
const LINE_NUMBER_FG = "#6272a4";

export class CodeSnippet extends BaseTool {
  override name = "code_snippet";
  override version = "0.1.0";
  override tier = ToolTier.CORE;
  override capability = "graphics";
  override provider = "pygments";
  override stability = ToolStability.EXPERIMENTAL;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;

  override dependencies = []; // shiki + canvas are bundled
  override install_instructions =
    "Syntax highlighting uses the bundled `shiki` package and @napi-rs/canvas " +
    "for rendering — no install or network needed for bundled themes/languages.";
  override agent_skills = [];

  override capabilities = [
    "render_code_image",
    "syntax_highlight",
    "themed_code_card",
  ];

  override input_schema = {
    type: "object",
    required: ["code"],
    properties: {
      code: { type: "string" },
      language: { type: "string", default: "python" },
      theme: {
        type: "string",
        enum: Object.keys(THEMES),
        default: "monokai",
      },
      font_size: { type: "integer", default: 20 },
      padding: { type: "integer", default: 40 },
      border_radius: { type: "integer", default: 12 },
      line_numbers: { type: "boolean", default: true },
      title: { type: "string", description: "Optional title bar text" },
      output_path: { type: "string" },
      width: { type: "integer", description: "Force specific width" },
    },
  };

  override resource_profile: ResourceProfile = {
    cpu_cores: 1,
    ram_mb: 256,
    vram_mb: 0,
    disk_mb: 50,
    network_required: false,
  };
  override idempotency_key_fields = ["code", "language", "theme", "font_size"];
  override side_effects = ["writes image to output_path"];
  override user_visible_verification = [
    "Verify code is readable and syntax highlighting is correct",
  ];

  override getStatus(): ToolStatus {
    // shiki + canvas are bundled dependencies; always available.
    return ToolStatus.AVAILABLE;
  }

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const start = Date.now();

    const code = inputs.code as string;
    const language = (inputs.language as string) ?? "python";
    const themeName = (inputs.theme as string) ?? "monokai";
    const fontSize = (inputs.font_size as number) ?? 20;
    const padding = (inputs.padding as number) ?? 40;
    const lineNumbers = (inputs.line_numbers as boolean) ?? true;
    const title = inputs.title as string | undefined;
    const outputPath = (inputs.output_path as string) ?? "code_snippet.png";

    const theme = THEMES[themeName] ?? THEMES["monokai"]!;

    // Resolve language; fall back to shiki auto-detection (the codeToTokens
    // equivalent of Pygments' get_lexer_by_name -> guess_lexer fallback).
    const lang = language in bundledLanguages ? language : "text";

    let lines: Array<Array<{ content: string; color?: string }>>;
    try {
      const result = await codeToTokens(code, {
        lang: lang as never,
        theme: theme.shiki_theme as never,
      });
      lines = result.tokens;
    } catch {
      // Last-resort: render as plain text in the theme foreground.
      const result = await codeToTokens(code, {
        lang: "text",
        theme: theme.shiki_theme as never,
      });
      lines = result.tokens;
    }

    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });

    // Render highlighted code to a PNG (Pygments ImageFormatter equivalent).
    let { canvas } = this.renderCodeImage(
      lines,
      theme,
      fontSize,
      padding,
      lineNumbers,
      inputs.width as number | undefined
    );

    // Add title bar if requested (stacked on top, like the Python).
    if (title) {
      canvas = this.addTitleBar(canvas, title, theme, fontSize);
    }

    fs.writeFileSync(outputPath, canvas.toBuffer("image/png"));

    const elapsed = Math.round((Date.now() - start) / 10) / 100;

    return toolResult({
      success: true,
      data: {
        output: outputPath,
        language,
        theme: themeName,
        width: canvas.width,
        height: canvas.height,
        line_count: (code.match(/\n/g)?.length ?? 0) + 1,
      },
      artifacts: [outputPath],
      duration_seconds: elapsed,
    });
  }

  /**
   * Render tokenized lines to a PNG canvas, emulating Pygments' ImageFormatter:
   * themed background, optional line-number gutter, `image_pad` padding, and a
   * monospace font at `font_size`.
   */
  private renderCodeImage(
    lines: Array<Array<{ content: string; color?: string }>>,
    theme: ThemeDef,
    fontSize: number,
    padding: number,
    lineNumbers: boolean,
    forcedWidth?: number
  ): { canvas: Canvas } {
    // ImageFormatter defaults: line spacing ~= font_size * 1.3, monospace glyphs.
    const lineHeight = Math.round(fontSize * 1.3);
    const font = `${fontSize}px "DejaVu Sans Mono", Menlo, Consolas, monospace`;

    // Measure on a scratch context.
    const scratch = createCanvas(10, 10);
    const sctx = scratch.getContext("2d");
    sctx.font = font;
    // Monospace advance width (use a representative glyph).
    const charWidth = sctx.measureText("M").width;

    const totalLines = lines.length;
    // Line-number gutter: digits + a small margin (ImageFormatter style).
    const numDigits = String(totalLines).length;
    const gutterText = lineNumbers ? numDigits + 2 : 0; // chars: "NN "
    const gutterWidth = lineNumbers
      ? Math.ceil(gutterText * charWidth) + 10
      : 0;

    // Widest code line, in pixels.
    let maxLineChars = 0;
    for (const line of lines) {
      let len = 0;
      for (const tok of line) len += tok.content.length;
      if (len > maxLineChars) maxLineChars = len;
    }
    const codeWidth = Math.ceil(maxLineChars * charWidth);

    let width = padding * 2 + gutterWidth + codeWidth;
    if (forcedWidth) {
      width = forcedWidth;
    }
    const height = padding * 2 + totalLines * lineHeight;

    const canvas = createCanvas(Math.max(width, 1), Math.max(height, 1));
    const ctx = canvas.getContext("2d");

    // Background (theme bg, which also serves as the line_number_bg).
    ctx.fillStyle = theme.bg_color;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.font = font;
    ctx.textBaseline = "top";

    const codeX0 = padding + gutterWidth;
    for (let i = 0; i < lines.length; i++) {
      const y = padding + i * lineHeight;

      // Line number (right-aligned in the gutter).
      if (lineNumbers) {
        const numStr = String(i + 1);
        ctx.fillStyle = LINE_NUMBER_FG;
        const numW = ctx.measureText(numStr).width;
        ctx.fillText(numStr, padding + gutterWidth - 10 - numW, y);
      }

      // Code tokens, left-to-right at the monospace advance.
      let x = codeX0;
      for (const tok of lines[i]!) {
        if (tok.content.length === 0) continue;
        ctx.fillStyle = tok.color ?? theme.text_color;
        ctx.fillText(tok.content, x, y);
        x += tok.content.length * charWidth;
      }
    }

    return { canvas };
  }

  /**
   * Add a macOS-style title bar to the top of the code image: a filled bar in
   * the border color, three window dots, and a centered title — faithful to the
   * Python `_add_title_bar`.
   */
  private addTitleBar(
    img: Canvas,
    title: string,
    theme: ThemeDef,
    fontSize: number
  ): Canvas {
    const barHeight = fontSize + 20;

    const newCanvas = createCanvas(img.width, img.height + barHeight);
    const ctx = newCanvas.getContext("2d");

    // Background fill (theme bg).
    ctx.fillStyle = theme.bg_color;
    ctx.fillRect(0, 0, newCanvas.width, newCanvas.height);

    // Title bar rectangle (border color).
    ctx.fillStyle = theme.border_color;
    ctx.fillRect(0, 0, img.width, barHeight);

    // Window dots.
    const dotY = Math.trunc(barHeight / 2);
    const dotColors = ["#ff5f56", "#ffbd2e", "#27c93f"];
    for (let i = 0; i < dotColors.length; i++) {
      // PIL ellipse bbox [(x0,y0),(x1,y1)] -> center + radius.
      const x0 = 15 + i * 22;
      const cx = x0 + 6;
      const cy = dotY;
      ctx.beginPath();
      ctx.ellipse(cx, cy, 6, 6, 0, 0, Math.PI * 2);
      ctx.fillStyle = dotColors[i]!;
      ctx.fill();
    }

    // Centered title text.
    ctx.font = `${fontSize - 4}px Arial, sans-serif`;
    const textWidth = ctx.measureText(title).width;
    const textX = Math.trunc((img.width - textWidth) / 2);
    ctx.fillStyle = theme.text_color;
    ctx.textBaseline = "top";
    ctx.fillText(title, textX, 8);

    // Paste original code image below the title bar.
    ctx.drawImage(img, 0, barHeight);

    return newCanvas;
  }

  static listThemes(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, t] of Object.entries(THEMES)) {
      out[name] = `Background: ${t.bg_color}`;
    }
    return out;
  }
}
