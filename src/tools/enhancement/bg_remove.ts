/**
 * Background removal tool (TypeScript port of tools/enhancement/bg_remove.py).
 *
 * Removes backgrounds from images and outputs transparent PNGs, or composites
 * the cutout onto a custom background color.
 *
 * Parity notes vs. Python:
 *  - The Python tool wrapped `rembg` (U2Net ONNX models) and declared
 *    runtime=HYBRID (local rembg OR optionally cloud). The local rembg engine
 *    depends on onnxruntime/PyTorch wheels that are excluded from this TS port,
 *    so local removal is implemented with the bundled, free, CPU-only
 *    `@imgly/background-removal-node` (ONNX/WASM, no torch). runtime stays
 *    HYBRID to match the contract.
 *  - input_schema, capabilities, side_effects, idempotency_key_fields,
 *    user_visible_verification, resource_profile, and the result `data` fields
 *    (input/output/model/alpha_matting/bg_color) are copied verbatim.
 *  - get_status(): Python returned AVAILABLE when `rembg` imported. The @imgly
 *    engine is bundled (no env var, no torch), so the equivalent local engine
 *    is always present → getStatus() returns AVAILABLE.
 *  - The rembg `model_name` values (u2net / u2net_human_seg / isnet-general-use)
 *    have no @imgly equivalent (@imgly models are small/medium/large), so the
 *    requested model name is echoed back in `data` for contract parity while the
 *    @imgly default model performs the segmentation. `alpha_matting` likewise has
 *    no @imgly knob; it is accepted and echoed back but is a no-op (Python applied
 *    rembg's alpha-matting refinement). These are recorded behavioral deviations.
 *  - Default output path mirrors Path.with_stem(f"{stem}_nobg").with_suffix(".png")
 *    — replace the stem with "{stem}_nobg" and force a .png extension.
 *  - bg_color compositing mirrors the PIL path: parse "#RRGGBB", paste the RGBA
 *    cutout over an opaque background of that color, and flatten to RGB. PIL's
 *    Image.paste(mask=alpha) is reproduced with sharp.flatten({background}).
 */
import fs from "node:fs";
import path from "node:path";
import {
  BaseTool,
  Determinism,
  ExecutionMode,
  ResourceProfile,
  ToolResult,
  ToolRuntime,
  ToolStability,
  ToolStatus,
  ToolTier,
  toolResult,
} from "../base_tool.js";
// NOTE: `sharp` and `@imgly/background-removal-node` are loaded lazily inside
// execute() — they pull native/ONNX binaries that must NOT be required during
// registry discovery (which only instantiates tools and reads contract fields).

/** Mirror Path.with_stem(f"{stem}_nobg").with_suffix(".png"). */
function defaultOutputPath(inputPath: string): string {
  const dir = path.dirname(inputPath);
  const ext = path.extname(inputPath);
  const stem = path.basename(inputPath, ext);
  return path.join(dir, `${stem}_nobg.png`);
}

export class BgRemove extends BaseTool {
  override name = "bg_remove";
  override version = "0.1.0";
  override tier = ToolTier.ENHANCE;
  override capability = "enhancement";
  override provider = "rembg";
  override stability = ToolStability.EXPERIMENTAL;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;
  override runtime = ToolRuntime.HYBRID;

  // The @imgly engine is bundled (free, CPU, ONNX/WASM) — no env or system
  // dependency to declare. Local removal is always available.
  override dependencies: string[] = [];
  override install_instructions =
    "Local background removal uses the bundled @imgly/background-removal-node " +
    "engine (free, CPU-only, no extra install). The model is downloaded on first use.";
  override agent_skills = ["ffmpeg"];

  override capabilities = [
    "background_removal",
    "alpha_matte",
    "batch_processing",
    "custom_background",
  ];

  override input_schema = {
    type: "object",
    required: ["input_path"],
    properties: {
      input_path: {
        type: "string",
        description: "Path to image or video frame",
      },
      output_path: {
        type: "string",
        description: "Output path; defaults to {stem}_nobg.png",
      },
      model: {
        type: "string",
        enum: ["u2net", "u2net_human_seg", "isnet-general-use"],
        default: "u2net",
      },
      bg_color: {
        type: "string",
        description:
          "Replacement background color hex (e.g. #00FF00). Transparent if not set.",
      },
      alpha_matting: {
        type: "boolean",
        default: false,
        description: "Use alpha matting for finer edges",
      },
    },
  };

  override resource_profile: ResourceProfile = {
    cpu_cores: 2,
    ram_mb: 2048,
    vram_mb: 0,
    disk_mb: 500,
    network_required: false,
  };

  override idempotency_key_fields = [
    "input_path",
    "model",
    "bg_color",
    "alpha_matting",
  ];
  override side_effects = ["writes background-removed image to output_path"];
  override user_visible_verification = [
    "Inspect output for clean edges around the subject",
    "Verify transparency or background color is applied correctly",
  ];

  override getStatus(): ToolStatus {
    // Python returned AVAILABLE when `rembg` was importable. The @imgly engine
    // is bundled with no extra dependency, so the local engine is always present.
    return ToolStatus.AVAILABLE;
  }

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    const inputPath = inputs.input_path as string;
    if (!fs.existsSync(inputPath)) {
      return toolResult({ success: false, error: `Input not found: ${inputPath}` });
    }

    const outputPath =
      (inputs.output_path as string) ?? defaultOutputPath(inputPath);
    const modelName = (inputs.model as string) ?? "u2net";
    const bgColor = inputs.bg_color as string | undefined;
    const alphaMatting = (inputs.alpha_matting as boolean) ?? false;

    const start = Date.now();

    try {
      // Lazy-load the native/ONNX engines only when actually removing a background.
      const { removeBackground } = await import("@imgly/background-removal-node");
      // Local removal via the bundled @imgly engine (ONNX/WASM, CPU). Returns a
      // transparent-background PNG Blob. Mirrors rembg.remove(input_image).
      const cutoutBlob = await removeBackground(inputPath, {
        output: { format: "image/png" },
      });
      let resultBuffer: Uint8Array = Buffer.from(await cutoutBlob.arrayBuffer());

      // Composite onto a colored background if requested (mirrors the PIL path:
      // new RGBA bg of the color, paste cutout using its alpha, convert to RGB).
      if (bgColor) {
        const sharp = (await import("sharp")).default;
        const hex = bgColor.replace(/^#/, "");
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        resultBuffer = await sharp(resultBuffer)
          .flatten({ background: { r, g, b } })
          .toFormat("png")
          .toBuffer();
      }

      fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
      fs.writeFileSync(outputPath, resultBuffer);
    } catch (e) {
      return toolResult({
        success: false,
        error: `Background removal failed: ${(e as Error).message ?? e}`,
      });
    }

    const elapsed = (Date.now() - start) / 1000;

    return toolResult({
      success: true,
      data: {
        input: inputPath,
        output: outputPath,
        model: modelName,
        alpha_matting: alphaMatting,
        bg_color: bgColor ?? null,
      },
      artifacts: [outputPath],
      duration_seconds: Math.round(elapsed * 100) / 100,
    });
  }
}
