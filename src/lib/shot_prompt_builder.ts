/**
 * Shot prompt builder (TS port of lib/shot_prompt_builder.py).
 * Converts structured shot language into provider-optimized generation prompts
 * via a 5-layer framework (camera, movement, subject, lighting, style). Pure logic.
 */
const SHOT_SIZE_PHRASES: Record<string, string> = {
  extreme_wide: "extreme wide shot showing vast environment",
  wide: "wide shot capturing full scene",
  medium_wide: "medium-wide shot framing subject with surroundings",
  medium: "medium shot from waist up",
  medium_close: "medium close-up from chest up",
  close_up: "close-up focusing on face or detail",
  extreme_close_up: "extreme close-up on fine detail",
  over_shoulder: "over-the-shoulder perspective",
  insert: "insert shot of specific detail",
  establishing: "establishing shot setting the location",
};

const MOVEMENT_PHRASES: Record<string, string> = {
  static: "locked-off static camera",
  pan_left: "smooth pan to the left",
  pan_right: "smooth pan to the right",
  tilt_up: "gentle tilt upward",
  tilt_down: "gentle tilt downward",
  dolly_in: "slow dolly in toward subject",
  dolly_out: "slow dolly out from subject",
  tracking_left: "tracking shot moving left alongside subject",
  tracking_right: "tracking shot moving right alongside subject",
  crane_up: "crane shot rising upward",
  crane_down: "crane shot descending",
  handheld: "handheld camera with natural movement",
  steadicam: "smooth steadicam following movement",
  whip_pan: "fast whip pan",
  orbital: "orbital camera circling subject",
  zoom_in: "slow zoom in",
  zoom_out: "slow zoom out",
  rack_focus: "rack focus shift between foreground and background",
};

const LIGHTING_PHRASES: Record<string, string> = {
  high_key: "bright high-key lighting, minimal shadows",
  low_key: "dramatic low-key lighting with deep shadows",
  natural: "natural ambient lighting",
  golden_hour: "warm golden hour sunlight",
  blue_hour: "cool blue hour twilight",
  tungsten_warm: "warm tungsten interior lighting",
  neon: "neon-lit with vibrant color spill",
  silhouette: "backlit silhouette",
  rim_lit: "rim lighting highlighting edges",
  volumetric: "volumetric light with visible rays",
  overcast_soft: "soft overcast diffused light",
};

const DOF_PHRASES: Record<string, string> = {
  shallow: "shallow depth of field with bokeh",
  medium: "medium depth of field",
  deep: "deep focus with everything sharp",
};

const COLOR_TEMP_PHRASES: Record<string, string> = {
  cool: "cool blue-toned color palette",
  neutral: "neutral balanced colors",
  warm: "warm amber-toned color palette",
  mixed: "mixed color temperatures for contrast",
};

const joinNonEmpty = (parts: Array<string | undefined | null>, sep: string): string =>
  parts.filter((p): p is string => Boolean(p)).join(sep);

/** Convert a scene with structured shot language into a generation prompt. */
export function buildShotPrompt(
  scene: Record<string, any>,
  styleContext?: Record<string, any> | null
): string {
  const sl: Record<string, any> = scene.shot_language ?? {};
  const layers: string[] = [];

  // Layer 1: Camera — lens + depth of field
  const cameraParts: string[] = [];
  if (sl.lens_mm) cameraParts.push(`${sl.lens_mm}mm lens`);
  if (sl.depth_of_field) cameraParts.push(DOF_PHRASES[sl.depth_of_field] ?? "");
  if (cameraParts.some(Boolean)) layers.push(joinNonEmpty(cameraParts, ", "));

  // Layer 2: Movement — shot size + camera movement
  const movementParts: string[] = [];
  if (sl.shot_size) movementParts.push(SHOT_SIZE_PHRASES[sl.shot_size] ?? sl.shot_size);
  if (sl.camera_movement && sl.camera_movement !== "static")
    movementParts.push(MOVEMENT_PHRASES[sl.camera_movement] ?? sl.camera_movement);
  if (movementParts.length > 0) layers.push(movementParts.join(", "));

  // Layer 3: Subject — description + texture keywords
  const description: string = scene.description ?? "";
  const texture: string[] = scene.texture_keywords ?? [];
  const subjectParts = [description];
  if (texture.length > 0) subjectParts.push(texture.join(", "));
  layers.push(joinNonEmpty(subjectParts, ". "));

  // Layer 4: Lighting — key + color temperature
  const lightingParts: string[] = [];
  if (sl.lighting_key) lightingParts.push(LIGHTING_PHRASES[sl.lighting_key] ?? sl.lighting_key);
  if (sl.color_temperature) lightingParts.push(COLOR_TEMP_PHRASES[sl.color_temperature] ?? "");
  if (lightingParts.some(Boolean)) layers.push(joinNonEmpty(lightingParts, ", "));

  // Layer 5: Style — adapted from playbook (not a verbatim prefix)
  if (styleContext) {
    const mood = styleContext.mood ?? "";
    const visualLang = styleContext.visual_language ?? {};
    const styleHint = visualLang.aesthetic || mood;
    if (styleHint) layers.push(`Style: ${styleHint}`);
  }

  return joinNonEmpty(layers, ". ");
}

/** Build prompts for all visual scenes in a scene plan. */
export function buildBatchPrompts(
  scenes: Array<Record<string, any>>,
  styleContext?: Record<string, any> | null
): Array<{ scene_id: string; prompt: string; hero_moment: boolean }> {
  const results: Array<{ scene_id: string; prompt: string; hero_moment: boolean }> = [];
  for (const scene of scenes) {
    if (scene.type === "transition") continue;
    results.push({
      scene_id: scene.id ?? "unknown",
      prompt: buildShotPrompt(scene, styleContext),
      hero_moment: scene.hero_moment ?? false,
    });
  }
  return results;
}
