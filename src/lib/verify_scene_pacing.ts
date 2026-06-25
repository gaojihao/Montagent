/** Verify a TerminalScene `steps` list paces with narration cues (TS port of
 * lib/verify_scene_pacing.py). Frame math mirrors TerminalScene.tsx. */
export interface Landmark {
  video_time: number;
  kind: string;
  text: string;
}

export function stepDuration(step: Record<string, any>, fps = 30): number {
  const k = step.kind;
  if (k === "cmd") {
    const typeFrames = Math.ceil((step.text as string).length * (step.typeSpeed ?? 0.035) * fps);
    return typeFrames / fps + (step.holdSeconds ?? 0.3);
  }
  if (k === "out") {
    const revealFrames = Math.max(2, Math.ceil(0.08 * fps));
    return revealFrames / fps + (step.holdSeconds ?? 0.15);
  }
  if (k === "pause") return Number(step.seconds);
  if (k === "pill") return 0.0;
  throw new Error(`Unknown step kind: ${JSON.stringify(k)}`);
}

export function trace(steps: Array<Record<string, any>>, sceneStart = 0.0, fps = 30, quiet = false): Landmark[] {
  let cursor = 0.0;
  const out: Landmark[] = [];
  for (const s of steps) {
    const k = s.kind;
    const vt = Math.round((cursor + sceneStart) * 100) / 100;
    if (k === "cmd" || k === "out" || k === "pill") {
      const text = s.text ?? "";
      out.push({ video_time: vt, kind: k.toUpperCase(), text });
      if (!quiet) console.log(`  ${vt.toFixed(2)}s  ${k.toUpperCase().padEnd(5)}${String(text).slice(0, 60)}`);
    }
    cursor += stepDuration(s, fps);
  }
  if (!quiet) console.log(`  ${(Math.round((cursor + sceneStart) * 100) / 100).toFixed(2)}s  -- steps end --`);
  return out;
}

export function assertAlignment(
  steps: Array<Record<string, any>>,
  sceneStart: number,
  sceneEnd: number,
  narrationCues: Array<[number, string]>,
  tolerance = 1.0,
  fps = 30
): void {
  const landmarks = trace(steps, sceneStart, fps, true);
  const errors: string[] = [];

  for (const [cueTime, cueDesc] of narrationCues) {
    if (landmarks.length === 0) {
      errors.push(`cue ${cueTime.toFixed(2)}s (${cueDesc}): no landmarks at all`);
      continue;
    }
    const closest = landmarks.reduce((a, b) => (Math.abs(b.video_time - cueTime) < Math.abs(a.video_time - cueTime) ? b : a));
    const delta = closest.video_time - cueTime;
    if (Math.abs(delta) > tolerance) {
      errors.push(
        `cue ${cueTime.toFixed(2)}s (${cueDesc}) has no visual within ±${tolerance.toFixed(1)}s — ` +
          `closest is ${closest.kind} at ${closest.video_time.toFixed(2)}s (${delta >= 0 ? "+" : ""}${delta.toFixed(2)}s off): ${closest.text.slice(0, 40)}`
      );
    }
  }

  const cursor = steps.reduce((acc, s) => acc + stepDuration(s, fps), 0);
  const endVt = sceneStart + cursor;
  const sceneDuration = sceneEnd - sceneStart;
  if (cursor > sceneDuration + 0.5) {
    errors.push(`steps overflow scene: cursor ends at ${endVt.toFixed(2)}s but scene_end is ${sceneEnd.toFixed(2)}s (overflow ${(cursor - sceneDuration).toFixed(2)}s)`);
  }
  if (cursor < sceneDuration - 5.0) {
    errors.push(`steps underfill scene by ${(sceneDuration - cursor).toFixed(2)}s — last visible step holds frozen from ${endVt.toFixed(2)}s to ${sceneEnd.toFixed(2)}s. Add a closer pause.`);
  }

  if (errors.length) throw new Error("Scene pacing check failed:\n  - " + errors.join("\n  - "));
}
