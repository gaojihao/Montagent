/** Environment loader (TS port of lib/env_loader.py). .env loading is handled by
 * base_tool's dotenv call at import; these mirror the typed-access helpers. */
export function getEnv(key: string, def?: string): string | undefined {
  return process.env[key] ?? def;
}

export function requireEnv(key: string): string {
  const v = process.env[key];
  if (v === undefined) throw new Error(`Required environment variable '${key}' is not set`);
  return v;
}

/** No-op in the TS port: base_tool already loads .env via dotenv at import time. */
export function loadEnv(): void {
  /* dotenv.config is invoked in base_tool.ts */
}
