/**
 * Subtitle generation tool.
 *
 * TypeScript port of tools/subtitle/subtitle_gen.py. Converts word-level
 * timestamps from the transcriber into SRT, VTT, or caption JSON formats.
 * Pure TypeScript — no external dependencies (node:fs only).
 *
 * Parity notes vs. Python:
 *  - dependencies=[] (pure), provider "montagent", capability "subtitle".
 *  - Cue grouping (_build_cues), word corrections (_apply_corrections), and the
 *    SRT/VTT/JSON renderers (including word_by_word and karaoke highlight modes
 *    with <b> tags and the `index*100+wi` numbering) match verbatim.
 *  - Timestamp formatters use floor + ms rounding identical to Python. Python's
 *    round() is banker's rounding; Math.round() rounds half-up. The only inputs
 *    that differ are exact x.xxx5-second boundaries, which never occur in
 *    practice for transcriber output — behavior is otherwise identical.
 *  - JSON output uses 2-space indentation to match json.dumps(..., indent=2).
 *  - DEVIATION (cosmetic, unavoidable): JS Number has no int/float distinction,
 *    so a whole-number timestamp serializes as `0` where Python's json.dumps
 *    emits `0.0`. All non-integer values and the parsed numeric result are
 *    identical; only the textual rendering of whole-number floats differs. A
 *    custom serializer was rejected because the input timestamps arrive as
 *    plain numbers with no reliable signal distinguishing them from genuine
 *    integers (e.g. cue `index`), so faking floats would risk corrupting those.
 */
import fs from "node:fs";
import path from "node:path";
import {
  BaseTool,
  Determinism,
  ExecutionMode,
  ResourceProfile,
  ToolResult,
  ToolStability,
  ToolTier,
  toolResult,
} from "../base_tool.js";

interface Word {
  word: string;
  start: number;
  end: number;
}

interface Segment {
  words?: Word[];
  text?: string;
  start?: number;
  end?: number;
}

interface Cue {
  index: number;
  start: number;
  end: number;
  text: string;
  words: Word[];
}

export class SubtitleGen extends BaseTool {
  override name = "subtitle_gen";
  override version = "0.1.0";
  override tier = ToolTier.CORE;
  override capability = "subtitle";
  override provider = "montagent";
  override stability = ToolStability.EXPERIMENTAL;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;

  override dependencies = []; // pure
  override install_instructions = "No external dependencies required.";
  override agent_skills = ["remotion-best-practices"];

  override capabilities = [
    "generate_srt",
    "generate_vtt",
    "generate_caption_json",
  ];

  override input_schema = {
    type: "object",
    required: ["segments"],
    properties: {
      segments: {
        type: "array",
        description:
          "Transcript segments from transcriber (with words and timestamps)",
      },
      format: {
        type: "string",
        enum: ["srt", "vtt", "json"],
        default: "srt",
      },
      output_path: { type: "string" },
      max_chars_per_line: { type: "integer", default: 42 },
      max_words_per_cue: { type: "integer", default: 8 },
      highlight_style: {
        type: "string",
        enum: ["none", "word_by_word", "karaoke"],
        default: "none",
      },
      corrections: {
        type: "object",
        description:
          "Dictionary of word corrections for common ASR misrecognitions. " +
          "Keys are the wrong word (case-insensitive), values are the " +
          "correct replacement. Applied before generating subtitles. " +
          'Example: {"cloud": "Claude", "co-pilot": "Copilot"}.',
      },
    },
  };

  override resource_profile: ResourceProfile = {
    cpu_cores: 1,
    ram_mb: 128,
    vram_mb: 0,
    disk_mb: 10,
    network_required: false,
  };
  override idempotency_key_fields = ["segments", "format", "max_words_per_cue"];
  override side_effects = ["writes subtitle file to output_path"];
  override user_visible_verification = [
    "Play video with generated subtitles and verify timing",
  ];

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    let segments = inputs.segments as Segment[];
    const fmt = (inputs.format as string) ?? "srt";
    const maxWords = (inputs.max_words_per_cue as number) ?? 8;
    const maxChars = (inputs.max_chars_per_line as number) ?? 42;
    const highlightStyle = (inputs.highlight_style as string) ?? "none";
    let outputPath = inputs.output_path as string | undefined;
    const corrections = inputs.corrections as Record<string, string> | undefined;

    const start = Date.now();

    // Apply word corrections if provided
    if (corrections) {
      segments = SubtitleGen._applyCorrections(segments, corrections);
    }

    // Build cues from word-level timestamps
    const cues = this._buildCues(segments, maxWords, maxChars);

    let content: string;
    let ext: string;
    if (fmt === "srt") {
      content = this._renderSrt(cues, highlightStyle);
      ext = ".srt";
    } else if (fmt === "vtt") {
      content = this._renderVtt(cues, highlightStyle);
      ext = ".vtt";
    } else if (fmt === "json") {
      content = JSON.stringify(
        { cues, highlight_style: highlightStyle },
        null,
        2
      );
      ext = ".caption.json";
    } else {
      return toolResult({ success: false, error: `Unknown format: ${fmt}` });
    }

    if (outputPath === undefined || outputPath === null) {
      outputPath = `subtitles${ext}`;
    }
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    fs.writeFileSync(outputPath, content, { encoding: "utf-8" });

    const elapsed = (Date.now() - start) / 1000;

    return toolResult({
      success: true,
      data: {
        format: fmt,
        cue_count: cues.length,
        output: outputPath,
      },
      artifacts: [outputPath],
      duration_seconds: Math.round(elapsed * 100) / 100,
    });
  }

  /**
   * Apply word-level corrections to transcript segments.
   * Handles case-insensitive matching and preserves punctuation.
   */
  private static _applyCorrections(
    segments: Segment[],
    corrections: Record<string, string>
  ): Segment[] {
    const corr: Record<string, string> = {};
    for (const [k, v] of Object.entries(corrections)) {
      corr[k.toLowerCase()] = v;
    }
    // deep copy (matches Python copy.deepcopy)
    const result: Segment[] = JSON.parse(JSON.stringify(segments));

    for (const seg of result) {
      const words = seg.words ?? [];
      for (const w of words) {
        const raw = (w.word ?? "").trim();
        // Strip punctuation for lookup, preserve it
        const stripped = rstrip(raw.toLowerCase(), ".,!?;:'\"");
        if (stripped in corr) {
          const trailing = raw.slice(stripped.length);
          w.word = corr[stripped] + trailing;
        }
      }
      // Also fix segment-level text
      if ("text" in seg && words.length) {
        seg.text = words.map((w) => w.word).join(" ");
      } else if ("text" in seg) {
        for (const [wrong, right] of Object.entries(corr)) {
          seg.text = (seg.text ?? "").replace(
            new RegExp(`\\b${escapeRegExp(wrong)}\\b`, "gi"),
            right
          );
        }
      }
    }

    return result;
  }

  /** Group words into display cues respecting max_words and max_chars. */
  private _buildCues(
    segments: Segment[],
    maxWords: number,
    maxChars: number
  ): Cue[] {
    // Collect all words with timestamps
    const allWords: Word[] = [];
    for (const seg of segments) {
      const words = seg.words ?? [];
      if (words.length) {
        allWords.push(...words);
      } else if ("text" in seg) {
        // Fallback: segment-level only (no word timestamps)
        allWords.push({
          word: seg.text as string,
          start: seg.start as number,
          end: seg.end as number,
        });
      }
    }

    if (!allWords.length) {
      return [];
    }

    const cues: Cue[] = [];
    let buf: Word[] = [];
    let bufText = "";

    for (const w of allWords) {
      const wordText = w.word.trim();
      const candidate = bufText ? `${bufText} ${wordText}`.trim() : wordText;

      if (buf.length && (buf.length >= maxWords || candidate.length > maxChars)) {
        cues.push({
          index: cues.length + 1,
          start: buf[0]!.start,
          end: buf[buf.length - 1]!.end,
          text: bufText,
          words: buf.map((b) => ({
            word: b.word.trim(),
            start: b.start,
            end: b.end,
          })),
        });
        buf = [];
        bufText = "";
      }

      buf.push(w);
      bufText = bufText ? `${bufText} ${wordText}`.trim() : wordText;
    }

    // Flush remaining
    if (buf.length) {
      cues.push({
        index: cues.length + 1,
        start: buf[0]!.start,
        end: buf[buf.length - 1]!.end,
        text: bufText,
        words: buf.map((b) => ({
          word: b.word.trim(),
          start: b.start,
          end: b.end,
        })),
      });
    }

    return cues;
  }

  private _renderSrt(cues: Cue[], highlightStyle = "none"): string {
    const lines: string[] = [];
    if (highlightStyle === "word_by_word") {
      // Emit one cue per word for word-by-word reveal
      let idx = 1;
      for (const cue of cues) {
        for (const wordInfo of cue.words ?? []) {
          lines.push(String(idx));
          lines.push(
            `${SubtitleGen._tsSrt(wordInfo.start)} --> ${SubtitleGen._tsSrt(wordInfo.end)}`
          );
          lines.push(wordInfo.word);
          lines.push("");
          idx += 1;
        }
      }
    } else if (highlightStyle === "karaoke") {
      // Show full cue text but bold the active word using SRT HTML tags
      for (const cue of cues) {
        const words = cue.words ?? [];
        if (!words.length) {
          lines.push(String(cue.index));
          lines.push(
            `${SubtitleGen._tsSrt(cue.start)} --> ${SubtitleGen._tsSrt(cue.end)}`
          );
          lines.push(cue.text);
          lines.push("");
          continue;
        }
        words.forEach((wordInfo, wi) => {
          lines.push(String(cue.index * 100 + wi));
          lines.push(
            `${SubtitleGen._tsSrt(wordInfo.start)} --> ${SubtitleGen._tsSrt(wordInfo.end)}`
          );
          const parts: string[] = [];
          words.forEach((w, wj) => {
            if (wj === wi) {
              parts.push(`<b>${w.word}</b>`);
            } else {
              parts.push(w.word);
            }
          });
          lines.push(parts.join(" "));
          lines.push("");
        });
      }
    } else {
      for (const cue of cues) {
        lines.push(String(cue.index));
        lines.push(
          `${SubtitleGen._tsSrt(cue.start)} --> ${SubtitleGen._tsSrt(cue.end)}`
        );
        lines.push(cue.text);
        lines.push("");
      }
    }
    return lines.join("\n");
  }

  private _renderVtt(cues: Cue[], highlightStyle = "none"): string {
    const lines: string[] = ["WEBVTT", ""];
    if (highlightStyle === "word_by_word") {
      for (const cue of cues) {
        for (const wordInfo of cue.words ?? []) {
          lines.push(
            `${SubtitleGen._tsVtt(wordInfo.start)} --> ${SubtitleGen._tsVtt(wordInfo.end)}`
          );
          lines.push(wordInfo.word);
          lines.push("");
        }
      }
    } else if (highlightStyle === "karaoke") {
      for (const cue of cues) {
        const words = cue.words ?? [];
        if (!words.length) {
          lines.push(
            `${SubtitleGen._tsVtt(cue.start)} --> ${SubtitleGen._tsVtt(cue.end)}`
          );
          lines.push(cue.text);
          lines.push("");
          continue;
        }
        words.forEach((wordInfo, wi) => {
          lines.push(
            `${SubtitleGen._tsVtt(wordInfo.start)} --> ${SubtitleGen._tsVtt(wordInfo.end)}`
          );
          const parts: string[] = [];
          words.forEach((w, wj) => {
            if (wj === wi) {
              parts.push(`<b>${w.word}</b>`);
            } else {
              parts.push(w.word);
            }
          });
          lines.push(parts.join(" "));
          lines.push("");
        });
      }
    } else {
      for (const cue of cues) {
        lines.push(
          `${SubtitleGen._tsVtt(cue.start)} --> ${SubtitleGen._tsVtt(cue.end)}`
        );
        lines.push(cue.text);
        lines.push("");
      }
    }
    return lines.join("\n");
  }

  /** Format seconds as SRT timestamp: HH:MM:SS,mmm */
  private static _tsSrt(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.round((seconds % 1) * 1000);
    return `${pad2(h)}:${pad2(m)}:${pad2(s)},${pad3(ms)}`;
  }

  /** Format seconds as VTT timestamp: HH:MM:SS.mmm */
  private static _tsVtt(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.round((seconds % 1) * 1000);
    return `${pad2(h)}:${pad2(m)}:${pad2(s)}.${pad3(ms)}`;
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

/** Mirror Python str.rstrip(chars): strip any trailing chars in `chars`. */
function rstrip(s: string, chars: string): string {
  let end = s.length;
  while (end > 0 && chars.includes(s[end - 1]!)) {
    end -= 1;
  }
  return s.slice(0, end);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
