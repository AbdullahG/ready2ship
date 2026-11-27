// Single source of runtime configuration. Every environment variable the app
// reads goes through here, so self-hosters have one place to look and a
// misconfigured deploy fails with a message naming every missing variable.
//
// Values are read at runtime (no NEXT_PUBLIC_ inlining), so one Docker image
// works for every deployment.

export interface AppConfig {
  isProduction: boolean;
  baseUrl: string;
  github: {
    appId: string;
    appSlug: string;
    botLogin: string;
    privateKey: string;
    webhookSecret: string;
    clientId: string;
    clientSecret: string;
    apiUrl: string;
    webUrl: string;
    /** Per-request timeout for GitHub API calls. */
    timeoutMs: number;
  };
  mongodb: { uri: string; dbName: string };
  sessionSecret: string;
  encryptionKey: Buffer;
  gemini: {
    /** Optional instance-wide default key, used by workspaces without their own. */
    apiKey: string | null;
    models: string[];
    /** Override for tests (fake Gemini server). */
    baseUrl: string | null;
    /** Per-request timeout for Gemini calls. */
    timeoutMs: number;
  };
  /** Lowercased GitHub account logins allowed to install. Empty = anyone. */
  allowedAccounts: string[];
  /** "Source" link shown in the UI. */
  sourceCodeUrl: string;
  jobs: {
    /** Parallel webhook jobs in this process; 0 disables the worker. */
    concurrency: number;
  };
  /** The OS PATH, handed to git subprocesses that otherwise get a minimal env. */
  systemPath: string;
}

const DEFAULT_SOURCE_URL = "https://github.com/AbdullahG/ready2ship";

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Accepts base64 of the PEM (one line, easy in secret managers) or the raw PEM,
// including the single-line form with literal "\n" that .env files produce.
function decodePrivateKey(value: string): string {
  const pem = value.includes("-----BEGIN")
    ? value.replace(/\\n/g, "\n")
    : Buffer.from(value, "base64").toString("utf-8");
  return pem.endsWith("\n") ? pem : `${pem}\n`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const missing: string[] = [];
  const problems: string[] = [];

  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) {
      missing.push(name);
      return "";
    }
    return value;
  };
  const optional = (name: string): string | null => env[name]?.trim() || null;

  const baseUrl = required("BASE_URL");
  const appId = required("GITHUB_APP_ID");
  const appSlug = required("GITHUB_APP_SLUG");
  const privateKey = required("GITHUB_APP_PRIVATE_KEY");
  const webhookSecret = required("GITHUB_WEBHOOK_SECRET");
  const clientId = required("GITHUB_CLIENT_ID");
  const clientSecret = required("GITHUB_CLIENT_SECRET");
  const mongoUri = required("MONGODB_URI");
  const sessionSecret = required("SESSION_SECRET");
  const encryptionKeyRaw = required("ENCRYPTION_KEY");
  const modelsRaw = required("GEMINI_MODELS");

  const models = list(modelsRaw);
  if (modelsRaw && models.length === 0) {
    problems.push("GEMINI_MODELS must list at least one model name (comma-separated)");
  }

  if (sessionSecret && sessionSecret.length < 32) {
    problems.push("SESSION_SECRET must be at least 32 characters");
  }

  const encryptionKey = Buffer.from(encryptionKeyRaw, "base64");
  if (encryptionKeyRaw && encryptionKey.length !== 32) {
    problems.push(
      "ENCRYPTION_KEY must be 32 bytes, base64-encoded (generate with: openssl rand -base64 32)"
    );
  }

  const positiveInt = (name: string, fallback: number): number => {
    const raw = optional(name);
    const value = raw === null ? fallback : Number(raw);
    if (!Number.isInteger(value) || value <= 0) problems.push(`${name} must be a positive whole number of milliseconds`);
    return value;
  };
  const githubTimeoutMs = positiveInt("GITHUB_TIMEOUT_MS", 30_000);
  const geminiTimeoutMs = positiveInt("GEMINI_TIMEOUT_MS", 120_000);

  const concurrencyRaw = optional("JOB_CONCURRENCY");
  const concurrency = concurrencyRaw === null ? 2 : Number(concurrencyRaw);
  if (!Number.isInteger(concurrency) || concurrency < 0) {
    problems.push("JOB_CONCURRENCY must be a whole number, 0 or more");
  }

  if (missing.length > 0) {
    problems.unshift(`Missing required environment variables: ${missing.join(", ")}`);
  }
  if (problems.length > 0) {
    throw new Error(`Invalid configuration. ${problems.join(". ")}. See .env.example.`);
  }

  return {
    isProduction: env.NODE_ENV === "production",
    baseUrl: trimSlash(baseUrl),
    github: {
      appId,
      appSlug,
      botLogin: `${appSlug}[bot]`,
      privateKey: decodePrivateKey(privateKey),
      webhookSecret,
      clientId,
      clientSecret,
      apiUrl: trimSlash(optional("GITHUB_API_URL") ?? "https://api.github.com"),
      webUrl: trimSlash(optional("GITHUB_WEB_URL") ?? "https://github.com"),
      timeoutMs: githubTimeoutMs,
    },
    mongodb: { uri: mongoUri, dbName: optional("MONGODB_DB") ?? "ready2ship" },
    sessionSecret,
    encryptionKey,
    gemini: {
      apiKey: optional("GEMINI_API_KEY"),
      models,
      baseUrl: optional("GEMINI_BASE_URL"),
      timeoutMs: geminiTimeoutMs,
    },
    allowedAccounts: list(env.ALLOWED_GITHUB_ACCOUNTS).map((s) => s.toLowerCase()),
    sourceCodeUrl: optional("SOURCE_CODE_URL") ?? DEFAULT_SOURCE_URL,
    jobs: { concurrency },
    systemPath: env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  };
}

let cached: AppConfig | null = null;

/** Lazily loaded so `next build` never needs runtime secrets. */
export function config(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

export function resetConfigForTests(): void {
  cached = null;
}
