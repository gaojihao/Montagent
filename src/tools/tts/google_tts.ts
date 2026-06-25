/**
 * Google Cloud Text-to-Speech provider tool.
 *
 * Google TTS offers 700+ voices across 50+ languages, including Standard,
 * WaveNet, Neural2, Studio, and Journey voice types — strong for localization.
 *
 * TypeScript port of tools/audio/google_tts.py.
 *
 * Parity notes vs. Python:
 *  - Python delegated service-account auth to tools/google_credentials.py
 *    (service_account_configured / get_access_token, backed by the `google-auth`
 *    package). To keep this file self-contained and dependency-free, the same two
 *    operations are reimplemented here with node:crypto: a file-existence check,
 *    and an OAuth2 JWT-bearer token mint (RS256-signed assertion exchanged at the
 *    Google token endpoint). Behaviorally identical to get_access_token.
 *  - Availability is reported via an overridden getStatus() because the tool is
 *    available through EITHER an API key (GOOGLE_API_KEY / GEMINI_API_KEY) OR a
 *    service-account JSON file — an OR that a single "env:" dependency cannot
 *    express. The check is the faithful translation of the Python get_status().
 *  - Endpoint (v1 vs v1beta1 for Chirp/Journey), JSON payload, base64 audio
 *    decode, extension mapping, and cost estimate all match the Python verbatim
 *    (requests -> fetch).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  BaseTool,
  Determinism,
  ExecutionMode,
  ResourceProfile,
  RetryPolicy,
  ToolResult,
  ToolRuntime,
  ToolStability,
  ToolStatus,
  ToolTier,
  toolResult,
} from "../base_tool.js";

// Broad scope that covers Cloud Text-to-Speech and Vertex AI prediction.
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

/** True when GOOGLE_APPLICATION_CREDENTIALS points to an existing file. */
function serviceAccountConfigured(): boolean {
  const p = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  return Boolean(p && fs.existsSync(p));
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
  project_id?: string;
}

/**
 * Mint an OAuth access token from the service-account JSON via the JWT-bearer
 * grant. Returns [access_token, project_id]. Faithful translation of the
 * Python get_access_token (which used google-auth under the hood).
 *
 * Throws Error with an agent-surfaceable message if the credentials are missing
 * or cannot be loaded/exchanged.
 */
async function getAccessToken(
  scopes: string[] = [CLOUD_PLATFORM_SCOPE]
): Promise<[string, string | null]> {
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyPath || !fs.existsSync(keyPath)) {
    throw new Error(
      "GOOGLE_APPLICATION_CREDENTIALS is not set or points to a missing " +
        "file; cannot use service-account authentication."
    );
  }

  let creds: ServiceAccountKey;
  try {
    creds = JSON.parse(fs.readFileSync(keyPath, "utf-8")) as ServiceAccountKey;
  } catch (exc) {
    throw new Error(
      `Failed to load/refresh service-account credentials from ${keyPath}: ${(exc as Error).message ?? exc}`
    );
  }

  try {
    const tokenUri = creds.token_uri ?? "https://oauth2.googleapis.com/token";
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", typ: "JWT" };
    const claims = {
      iss: creds.client_email,
      scope: scopes.join(" "),
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    };
    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(
      JSON.stringify(claims)
    )}`;
    const signature = crypto
      .createSign("RSA-SHA256")
      .update(signingInput)
      .sign(creds.private_key);
    const assertion = `${signingInput}.${base64url(signature)}`;

    const response = await fetch(tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      throw new Error(`token endpoint HTTP ${response.status}: ${errBody}`);
    }
    const tokenData = (await response.json()) as { access_token?: string };
    if (!tokenData.access_token) {
      throw new Error("token endpoint returned no access_token");
    }
    return [tokenData.access_token, creds.project_id ?? null];
  } catch (exc) {
    throw new Error(
      `Failed to load/refresh service-account credentials from ${keyPath}: ${(exc as Error).message ?? exc}`
    );
  }
}

export class GoogleTTS extends BaseTool {
  override name = "google_tts";
  override version = "0.1.0";
  override tier = ToolTier.VOICE;
  override capability = "tts";
  override provider = "google_tts";
  override stability = ToolStability.BETA;
  override execution_mode = ExecutionMode.SYNC;
  override determinism = Determinism.DETERMINISTIC;
  override runtime = ToolRuntime.API;

  override dependencies = [];
  override install_instructions =
    "Auth option A — API key: set GOOGLE_API_KEY (or GEMINI_API_KEY) to a\n" +
    "  Google Cloud API key with Text-to-Speech enabled.\n" +
    "  Enable the API at https://console.cloud.google.com/apis/library/texttospeech.googleapis.com\n" +
    "Auth option B — service account: set GOOGLE_APPLICATION_CREDENTIALS to the\n" +
    "  path of a service-account JSON key (needs the 'google-auth' package).";
  override fallback = "openai_tts";
  override fallback_tools = ["openai_tts", "elevenlabs_tts", "piper_tts"];
  override agent_skills = ["text-to-speech"];

  override capabilities = [
    "text_to_speech",
    "voice_selection",
    "ssml_support",
    "multilingual",
  ];
  override supports = {
    voice_cloning: false,
    multilingual: true,
    offline: false,
    native_audio: true,
    ssml: true,
  };
  override best_for = [
    "localization — 700+ voices across 50+ languages",
    "affordable high-quality TTS (Neural2, WaveNet)",
    "Google ecosystem integration",
  ];
  override not_good_for = ["voice cloning", "fully offline production"];

  override input_schema = {
    type: "object",
    required: ["text"],
    properties: {
      text: { type: "string", description: "Text to convert to speech" },
      voice: {
        type: "string",
        default: "en-US-Chirp3-HD-Orus",
        description:
          "Voice name. Default tier is Chirp 3 HD (2024, most natural). Examples: en-US-Chirp3-HD-Orus (male, rich/cinematic), en-US-Chirp3-HD-Aoede (female, warm). Legacy tiers: en-US-Studio-O, en-US-Neural2-D, en-US-Journey-D.",
      },
      language_code: {
        type: "string",
        default: "en-US",
        description: "BCP-47 language code (e.g. en-US, es-ES, ja-JP, fr-FR)",
      },
      speaking_rate: {
        type: "number",
        default: 1.0,
        minimum: 0.25,
        maximum: 4.0,
        description:
          "Speaking speed. 1.0 = normal, 0.5 = half speed, 2.0 = double speed",
      },
      pitch: {
        type: "number",
        default: 0.0,
        minimum: -20.0,
        maximum: 20.0,
        description: "Pitch adjustment in semitones. 0.0 = default",
      },
      audio_encoding: {
        type: "string",
        default: "MP3",
        enum: ["MP3", "LINEAR16", "OGG_OPUS", "MULAW", "ALAW"],
        description: "Audio output encoding format",
      },
      output_path: { type: "string" },
    },
  };

  override resource_profile: ResourceProfile = {
    cpu_cores: 1,
    ram_mb: 256,
    vram_mb: 0,
    disk_mb: 50,
    network_required: true,
  };
  override retry_policy: RetryPolicy = {
    max_retries: 2,
    backoff_seconds: 1.0,
    retryable_errors: ["rate_limit", "timeout"],
  };
  override idempotency_key_fields = [
    "text",
    "voice",
    "language_code",
    "speaking_rate",
    "pitch",
  ];
  override side_effects = [
    "writes audio file to output_path",
    "calls Google Cloud TTS API",
  ];
  override user_visible_verification = [
    "Listen to generated audio for natural speech quality",
  ];

  // Extension mapping for audio encodings
  static readonly EXT_MAP: Record<string, string> = {
    MP3: "mp3",
    LINEAR16: "wav",
    OGG_OPUS: "ogg",
    MULAW: "wav",
    ALAW: "wav",
  };

  // Voices requiring the v1beta1 endpoint (Chirp 3 HD, Journey)
  static readonly BETA_VOICE_PREFIXES = ["Chirp", "Journey"];

  private getApiKey(): string | undefined {
    return process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  }

  override getStatus(): ToolStatus {
    // Available via either an API key or a service-account JSON. Both paths
    // are honoured by execute() — so this no longer over-reports.
    if (this.getApiKey() || serviceAccountConfigured()) {
      return ToolStatus.AVAILABLE;
    }
    return ToolStatus.UNAVAILABLE;
  }

  /** Check if voice requires the v1beta1 endpoint. */
  private needsBetaApi(voice: string): boolean {
    return GoogleTTS.BETA_VOICE_PREFIXES.some((prefix) =>
      voice.includes(prefix)
    );
  }

  override estimateCost(inputs: Record<string, unknown>): number {
    const text = (inputs.text as string) ?? "";
    const charCount = text.length;
    const voice = (inputs.voice as string) ?? "en-US-Chirp3-HD-Orus";
    // Pricing per million characters (approximate)
    let ratePerChar: number;
    if (voice.includes("Chirp3-HD")) {
      ratePerChar = 0.00003; // $30/1M chars
    } else if (voice.includes("Studio")) {
      ratePerChar = 0.00016; // $160/1M chars
    } else if (voice.includes("Neural2") || voice.includes("Journey")) {
      ratePerChar = 0.000016; // $16/1M chars
    } else if (voice.includes("WaveNet")) {
      ratePerChar = 0.000016; // $16/1M chars
    } else {
      ratePerChar = 0.000004; // $4/1M chars (Standard)
    }
    return Math.round(charCount * ratePerChar * 10000) / 10000;
  }

  override async execute(inputs: Record<string, unknown>): Promise<ToolResult> {
    // Prefer an API key (cheapest path); otherwise mint a Bearer token from
    // the service-account JSON. This is what makes
    // GOOGLE_APPLICATION_CREDENTIALS actually work for TTS.
    const apiKey = this.getApiKey();
    let bearerToken: string | null = null;
    if (!apiKey) {
      if (serviceAccountConfigured()) {
        try {
          [bearerToken] = await getAccessToken();
        } catch (exc) {
          return toolResult({
            success: false,
            error: (exc as Error).message ?? String(exc),
          });
        }
      } else {
        return toolResult({
          success: false,
          error: "No Google credentials found. " + this.install_instructions,
        });
      }
    }

    const start = Date.now();
    let result: ToolResult;
    try {
      result = await this.generate(inputs, apiKey ?? null, bearerToken);
    } catch (exc) {
      return toolResult({
        success: false,
        error: `Google TTS failed: ${(exc as Error).message ?? exc}`,
      });
    }

    result.duration_seconds = Math.round((Date.now() - start) / 10) / 100;
    result.cost_usd = this.estimateCost(inputs);
    return result;
  }

  /** Real fetch translation of the Python `requests.post` call. */
  private async generate(
    inputs: Record<string, unknown>,
    apiKey: string | null,
    bearerToken: string | null
  ): Promise<ToolResult> {
    const text = inputs.text as string;
    const voiceName = (inputs.voice as string) ?? "en-US-Chirp3-HD-Orus";
    const languageCode = (inputs.language_code as string) ?? "en-US";
    const speakingRate = (inputs.speaking_rate as number) ?? 1.0;
    const pitch = (inputs.pitch as number) ?? 0.0;
    const audioEncoding = (inputs.audio_encoding as string) ?? "MP3";

    const payload = {
      input: { text },
      voice: {
        languageCode,
        name: voiceName,
      },
      audioConfig: {
        audioEncoding,
        speakingRate,
        pitch,
      },
    };

    // Chirp 3 HD and Journey voices require the v1beta1 endpoint
    const apiVersion = this.needsBetaApi(voiceName) ? "v1beta1" : "v1";
    const url = new URL(
      `https://texttospeech.googleapis.com/${apiVersion}/text:synthesize`
    );

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (bearerToken) {
      headers["Authorization"] = `Bearer ${bearerToken}`;
    } else if (apiKey) {
      url.searchParams.set("key", apiKey);
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      throw new Error(
        `HTTP ${response.status} ${response.statusText}: ${errBody}`
      );
    }

    const responseJson = (await response.json()) as { audioContent: string };
    const audioContent = Buffer.from(responseJson.audioContent, "base64");

    const ext = GoogleTTS.EXT_MAP[audioEncoding] ?? "mp3";
    const outputPath = path.resolve(
      (inputs.output_path as string) ?? `tts_output.${ext}`
    );
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, audioContent);

    return toolResult({
      success: true,
      data: {
        provider: this.provider,
        voice: voiceName,
        language_code: languageCode,
        text_length: text.length,
        output: outputPath,
        format: audioEncoding,
        speaking_rate: speakingRate,
        pitch,
      },
      artifacts: [outputPath],
      model: `google-tts/${voiceName}`,
    });
  }
}
