// Settings come from the environment, never from code.

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function number(name: string, fallback?: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") {
    if (fallback === undefined) throw new Error(`${name} is not set`);
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a number greater than zero`);
  return value;
}

export interface BedrockSettings {
  apiKey: string;
  region: string;
  modelId: string;
  priceInputPerMtok: number;
  priceOutputPerMtok: number;
  monthlyLimitUsd: number;
  timeoutMs: number;
}

export interface Config {
  databaseUrl: string;
  port: number;
  /** Shared secret that only the web app knows. It lets the web app open a profile for a visitor. */
  serviceKey: string;
  /** Profiles that have not been used for this long are deleted (the public demo keeps nothing for long). */
  profileTtlHours: number;
  allowedHosts: string[];
  /** Absent when no Bedrock key is set: the rules then rank the suggestions alone. */
  bedrock: BedrockSettings | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  void env;
  const apiKey = process.env.AWS_BEARER_TOKEN_BEDROCK?.trim();
  return {
    databaseUrl: required("DATABASE_URL"),
    port: number("PORT", 8081),
    serviceKey: required("SERVICE_KEY"),
    profileTtlHours: number("PROFILE_TTL_HOURS", 24),
    allowedHosts: (process.env.ALLOWED_HOSTS ?? "localhost,127.0.0.1,::1")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean),
    bedrock: apiKey
      ? {
          apiKey,
          region: required("AWS_REGION"),
          modelId: required("BEDROCK_MODEL_ID"),
          priceInputPerMtok: number("BEDROCK_PRICE_INPUT_USD_PER_MTOK"),
          priceOutputPerMtok: number("BEDROCK_PRICE_OUTPUT_USD_PER_MTOK"),
          monthlyLimitUsd: number("BEDROCK_MONTHLY_LIMIT_USD"),
          timeoutMs: number("BEDROCK_TIMEOUT_SECONDS", 20) * 1000,
        }
      : null,
  };
}
