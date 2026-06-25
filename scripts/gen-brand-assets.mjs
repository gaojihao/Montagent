/**
 * Generate Montagent brand assets (free, local, no API keys) with @napi-rs/canvas.
 *   assets/logo.png            800x800   app-icon lockup
 *   assets/social_preview.png  1280x640  GitHub/social card
 *   assets/diagram.png         1600x1000 architecture / "how it works"
 *
 * Palette = the project's own `flat-motion-graphics` playbook.
 * Run: node scripts/gen-brand-assets.mjs
 */
import { createCanvas } from "@napi-rs/canvas";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = path.join(ROOT, "assets");
fs.mkdirSync(ASSETS, { recursive: true });

const C = {
  bg: "#0F172A",
  bg2: "#111c34",
  surface: "#1E293B",
  stroke: "#334155",
  violet: "#7C3AED",
  pink: "#EC4899",
  cyan: "#22D3EE",
  text: "#F8FAFC",
  muted: "#94A3B8",
};
const FONT = "Helvetica"; // macOS system font; @napi-rs/canvas auto-loads it

function rr(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}
function grad(ctx, x0, y0, x1, y1, a = C.violet, b = C.pink) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  g.addColorStop(0, a);
  g.addColorStop(1, b);
  return g;
}
function bg(ctx, w, h) {
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, w, h);
  const g = ctx.createRadialGradient(w * 0.18, h * 0.12, 0, w * 0.18, h * 0.12, w * 0.9);
  g.addColorStop(0, "rgba(124,58,237,0.30)");
  g.addColorStop(0.5, "rgba(236,72,153,0.10)");
  g.addColorStop(1, "rgba(15,23,42,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}
/** A filmstrip + play-triangle mark, gradient-filled, in a box at (x,y,size). */
function mark(ctx, x, y, size) {
  const w = size,
    h = size * 0.72;
  ctx.save();
  ctx.translate(x, y + (size - h) / 2);
  // film body
  rr(ctx, 0, 0, w, h, size * 0.14);
  ctx.fillStyle = grad(ctx, 0, 0, w, h);
  ctx.fill();
  // sprocket holes (top + bottom)
  const hole = w * 0.06,
    gap = w * 0.085;
  ctx.fillStyle = "rgba(15,23,42,0.85)";
  for (let cx = gap; cx < w - hole; cx += gap + hole) {
    rr(ctx, cx, h * 0.07, hole, h * 0.1, hole * 0.35);
    ctx.fill();
    rr(ctx, cx, h * 0.83, hole, h * 0.1, hole * 0.35);
    ctx.fill();
  }
  // center play triangle (knocked out, light)
  ctx.fillStyle = C.text;
  const cx = w / 2,
    cy = h / 2,
    t = h * 0.22;
  ctx.beginPath();
  ctx.moveTo(cx - t * 0.7, cy - t);
  ctx.lineTo(cx - t * 0.7, cy + t);
  ctx.lineTo(cx + t, cy);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}
function centerText(ctx, text, cx, y, font, fill) {
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = fill;
  ctx.fillText(text, cx, y);
}

// ---------------- logo.png (800x800) ----------------
{
  const W = 800,
    H = 800;
  const cv = createCanvas(W, H);
  const ctx = cv.getContext("2d");
  bg(ctx, W, H);
  // app tile
  rr(ctx, 120, 120, 560, 560, 110);
  ctx.fillStyle = C.surface;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(124,58,237,0.55)";
  ctx.stroke();
  mark(ctx, 250, 232, 300);
  centerText(ctx, "Montagent", W / 2, 600, `bold 86px ${FONT}`, C.text);
  centerText(ctx, "montage + agent", W / 2, 645, `28px ${FONT}`, C.muted);
  fs.writeFileSync(path.join(ASSETS, "logo.png"), cv.toBuffer("image/png"));
}

// ---------------- social_preview.png (1280x640) ----------------
{
  const W = 1280,
    H = 640;
  const cv = createCanvas(W, H);
  const ctx = cv.getContext("2d");
  bg(ctx, W, H);
  mark(ctx, 90, 96, 150);
  // wordmark (gradient)
  ctx.font = `bold 132px ${FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = grad(ctx, 90, 0, 760, 0);
  ctx.fillText("Montagent", 90, 330);
  ctx.font = `36px ${FONT}`;
  ctx.fillStyle = C.text;
  ctx.fillText("An AI agent that turns a brief into a finished video.", 92, 392);
  // pipeline ribbon
  const stages = ["research", "script", "scene_plan", "assets", "edit", "compose"];
  ctx.font = `26px ${FONT}`;
  let x = 92;
  const y = 470,
    ph = 56,
    pad = 26;
  for (let i = 0; i < stages.length; i++) {
    const tw = ctx.measureText(stages[i]).width + pad * 2;
    rr(ctx, x, y, tw, ph, ph / 2);
    ctx.fillStyle = i === stages.length - 1 ? grad(ctx, x, y, x + tw, y) : C.surface;
    ctx.fill();
    ctx.strokeStyle = C.stroke;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = C.text;
    ctx.textAlign = "center";
    ctx.fillText(stages[i], x + tw / 2, y + 37);
    x += tw;
    if (i < stages.length - 1) {
      ctx.strokeStyle = C.muted;
      ctx.beginPath();
      ctx.moveTo(x + 8, y + ph / 2);
      ctx.lineTo(x + 26, y + ph / 2);
      ctx.stroke();
      // arrowhead
      ctx.fillStyle = C.muted;
      ctx.beginPath();
      ctx.moveTo(x + 26, y + ph / 2 - 5);
      ctx.lineTo(x + 34, y + ph / 2);
      ctx.lineTo(x + 26, y + ph / 2 + 5);
      ctx.fill();
      x += 42;
    }
  }
  centerText(ctx, "75 typed tools · Remotion · FFmpeg · HyperFrames · zero-key demo flow", W / 2, 580, `25px ${FONT}`, C.muted);
  fs.writeFileSync(path.join(ASSETS, "social_preview.png"), cv.toBuffer("image/png"));
}

// ---------------- diagram.png (1600x1000) ----------------
{
  const W = 1600,
    H = 1000;
  const cv = createCanvas(W, H);
  const ctx = cv.getContext("2d");
  bg(ctx, W, H);
  centerText(ctx, "Montagent — how it works", W / 2, 86, `bold 52px ${FONT}`, C.text);
  centerText(ctx, "The agent is the intelligence: it reads instructions and drives a typed tool pipeline.", W / 2, 130, `26px ${FONT}`, C.muted);

  const box = (x, y, w, h, title, sub, gradient = false) => {
    rr(ctx, x, y, w, h, 18);
    if (gradient) {
      ctx.fillStyle = grad(ctx, x, y, x + w, y + h);
    } else {
      ctx.fillStyle = C.surface;
    }
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = gradient ? "rgba(255,255,255,0.25)" : C.stroke;
    ctx.stroke();
    ctx.textAlign = "center";
    ctx.fillStyle = C.text;
    ctx.font = `bold 30px ${FONT}`;
    ctx.fillText(title, x + w / 2, y + (sub ? h / 2 - 4 : h / 2 + 10));
    if (sub) {
      ctx.font = `21px ${FONT}`;
      ctx.fillStyle = gradient ? "rgba(255,255,255,0.9)" : C.muted;
      ctx.fillText(sub, x + w / 2, y + h / 2 + 30);
    }
  };
  const arrow = (x0, y0, x1, y1) => {
    ctx.strokeStyle = C.violet;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    const ang = Math.atan2(y1 - y0, x1 - x0);
    ctx.fillStyle = C.violet;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - 13 * Math.cos(ang - 0.4), y1 - 13 * Math.sin(ang - 0.4));
    ctx.lineTo(x1 - 13 * Math.cos(ang + 0.4), y1 - 13 * Math.sin(ang + 0.4));
    ctx.fill();
  };

  // Row 1: Brief -> Agent -> Finished Video
  const ry = 200,
    bh = 110;
  box(70, ry, 250, bh, "Brief / Idea", '"60s explainer on…"');
  box(560, ry, 480, bh, "Agent", "reads AGENT_GUIDE.md + skills, orchestrates", true);
  box(1280, ry, 250, bh, "Finished Video", "1080p · h264");
  arrow(322, ry + bh / 2, 556, ry + bh / 2);
  arrow(1042, ry + bh / 2, 1276, ry + bh / 2);

  // Pipeline stages (under the agent)
  const stages = ["research", "proposal", "script", "scene_plan", "assets", "edit", "compose"];
  const sy = 400,
    sh = 64,
    sw = 196,
    sgap = 16;
  const totalW = stages.length * sw + (stages.length - 1) * sgap;
  let sx = (W - totalW) / 2;
  arrow(800, ry + bh, 800, sy - 6);
  centerText(ctx, "PIPELINE (checkpointed, human-approved gates)", W / 2, sy - 22, `bold 22px ${FONT}`, C.cyan);
  for (let i = 0; i < stages.length; i++) {
    box(sx, sy, sw, sh, stages[i], "", false);
    if (i < stages.length - 1) arrow(sx + sw, sy + sh / 2, sx + sw + sgap, sy + sh / 2);
    sx += sw + sgap;
  }

  // Tools layer + 3-layer note
  const ty = 560;
  arrow(W / 2, sy + sh, W / 2, ty - 6);
  box(120, ty, W - 240, 150, "", "", false);
  centerText(ctx, "75 typed tools  (GPU/PyTorch-free)", W / 2, ty + 46, `bold 30px ${FONT}`, C.text);
  const chips = ["TTS", "Image", "Video", "Music", "Stock ×16", "FFmpeg", "Remotion", "HyperFrames", "Analysis", "Subtitle", "Character", "Selectors"];
  ctx.font = `22px ${FONT}`;
  const cgap = 14;
  let widths = chips.map((c) => ctx.measureText(c).width + 32);
  let totalC = widths.reduce((a, b) => a + b + cgap, -cgap);
  let cx = (W - totalC) / 2;
  for (let i = 0; i < chips.length; i++) {
    rr(ctx, cx, ty + 78, widths[i], 44, 22);
    ctx.fillStyle = C.bg2;
    ctx.fill();
    ctx.strokeStyle = "rgba(124,58,237,0.5)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    centerText(ctx, chips[i], cx + widths[i] / 2, ty + 107, `22px ${FONT}`, C.text);
    cx += widths[i] + cgap;
  }

  centerText(
    ctx,
    "3 instruction layers:  tools/ (capabilities)   ·   skills/ (how)   ·   .agents/skills/ (vendor knowledge)",
    W / 2,
    ty + 210,
    `24px ${FONT}`,
    C.muted
  );
  centerText(ctx, "TypeScript / Node 22 · ESM · pnpm", W / 2, ty + 250, `20px ${FONT}`, C.stroke);
  fs.writeFileSync(path.join(ASSETS, "diagram.png"), cv.toBuffer("image/png"));
}

console.log("Wrote: assets/logo.png, assets/social_preview.png, assets/diagram.png");
