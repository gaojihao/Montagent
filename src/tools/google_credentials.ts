/**
 * Shared Google service-account authentication (TS port of tools/google_credentials.py).
 *
 * Lets the Google provider tools (google_tts, google_imagen) authenticate with a
 * service-account JSON key via OAuth Bearer tokens, in addition to the API-key path.
 *
 * Parity note: the Python version used the `google-auth` package. To stay free and
 * dependency-light, the TS port implements the OAuth2 service-account JWT-bearer flow
 * directly with `node:crypto` (RS256-sign a JWT, exchange it at the token endpoint).
 * No `google-auth` / `google-auth-library` dependency required.
 */
import fs from "node:fs";
import crypto from "node:crypto";

// Broad scope that covers Cloud Text-to-Speech and Vertex AI prediction.
export const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

/** True when GOOGLE_APPLICATION_CREDENTIALS points to an existing file. */
export function serviceAccountConfigured(): boolean {
  const p = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  return Boolean(p && fs.existsSync(p));
}

/** Resolve the GCP project id from env vars, falling back to the key file's. */
export function resolveProjectId(credsProjectId?: string | null): string | undefined {
  return (
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT_ID ||
    process.env.GCLOUD_PROJECT ||
    credsProjectId ||
    undefined
  );
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Mint an OAuth access token from the service-account JSON.
 * Returns [access_token, project_id]. Throws a RuntimeError-equivalent with an
 * actionable message if credentials are missing or the exchange fails.
 */
export async function getAccessToken(
  scopes: string[] = [CLOUD_PLATFORM_SCOPE]
): Promise<[string, string | undefined]> {
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyPath || !fs.existsSync(keyPath)) {
    throw new Error(
      "GOOGLE_APPLICATION_CREDENTIALS is not set or points to a missing file; " +
        "cannot use service-account authentication."
    );
  }

  let key: { client_email: string; private_key: string; token_uri?: string; project_id?: string };
  try {
    key = JSON.parse(fs.readFileSync(keyPath, "utf-8"));
  } catch (exc) {
    throw new Error(`Failed to load service-account credentials from ${keyPath}: ${(exc as Error).message}`);
  }

  const tokenUri = key.token_uri || "https://oauth2.googleapis.com/token";
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64url(
    JSON.stringify({
      iss: key.client_email,
      scope: scopes.join(" "),
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    })
  );
  const signingInput = `${header}.${claim}`;

  let signature: string;
  try {
    const signer = crypto.createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    signature = base64url(signer.sign(key.private_key));
  } catch (exc) {
    throw new Error(`Failed to sign service-account JWT: ${(exc as Error).message}`);
  }

  const assertion = `${signingInput}.${signature}`;
  const resp = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Failed to refresh service-account credentials from ${keyPath}: HTTP ${resp.status} ${body}`);
  }
  const data = (await resp.json()) as { access_token?: string };
  if (!data.access_token) throw new Error(`No access_token in token response from ${tokenUri}`);
  return [data.access_token, key.project_id];
}
