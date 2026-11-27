import { describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n";

function validEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    BASE_URL: "https://r2s.example.com/",
    GITHUB_APP_ID: "123",
    GITHUB_APP_SLUG: "my-review-app",
    GITHUB_APP_PRIVATE_KEY: Buffer.from(PEM).toString("base64"),
    GITHUB_WEBHOOK_SECRET: "whsec",
    GITHUB_CLIENT_ID: "cid",
    GITHUB_CLIENT_SECRET: "csecret",
    MONGODB_URI: "mongodb://localhost:27017",
    SESSION_SECRET: "s".repeat(32),
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    GEMINI_MODELS: "m-default",
    ...overrides,
  };
}

describe("loadConfig", () => {
  it("parsesAValidEnvironmentAndAppliesDefaults", () => {
    const c = loadConfig(validEnv());

    expect(c.baseUrl).toBe("https://r2s.example.com");
    expect(c.github.appSlug).toBe("my-review-app");
    expect(c.github.botLogin).toBe("my-review-app[bot]");
    expect(c.github.privateKey).toBe(PEM);
    expect(c.github.apiUrl).toBe("https://api.github.com");
    expect(c.github.webUrl).toBe("https://github.com");
    expect(c.mongodb.dbName).toBe("ready2ship");
    expect(c.encryptionKey.length).toBe(32);
    expect(c.gemini.apiKey).toBeNull();
    expect(c.gemini.models).toEqual(["m-default"]);
    expect(c.allowedAccounts).toEqual([]);
    expect(c.sourceCodeUrl).toMatch(/^https:\/\/github\.com\//);
    expect(c.jobs.concurrency).toBe(2);
  });

  it("listsEveryMissingRequiredVariableInOneError", () => {
    const env = validEnv({ GITHUB_APP_ID: undefined, MONGODB_URI: "" });
    expect(() => loadConfig(env)).toThrow(/GITHUB_APP_ID.*MONGODB_URI|MONGODB_URI.*GITHUB_APP_ID/);
  });

  it("requiresGeminiModels", () => {
    expect(() => loadConfig(validEnv({ GEMINI_MODELS: undefined }))).toThrow(/Missing required.*GEMINI_MODELS/);
    expect(() => loadConfig(validEnv({ GEMINI_MODELS: "  " }))).toThrow(/Missing required.*GEMINI_MODELS/);
    expect(() => loadConfig(validEnv({ GEMINI_MODELS: " , ," }))).toThrow(/GEMINI_MODELS must list at least one model/);
  });

  it("rejectsAShortSessionSecret", () => {
    expect(() => loadConfig(validEnv({ SESSION_SECRET: "short" }))).toThrow(/SESSION_SECRET/);
  });

  it("rejectsAnEncryptionKeyThatIsNot32Bytes", () => {
    const bad = Buffer.alloc(16).toString("base64");
    expect(() => loadConfig(validEnv({ ENCRYPTION_KEY: bad }))).toThrow(/ENCRYPTION_KEY/);
  });

  it("parsesJobConcurrencyAndRejectsNonsense", () => {
    expect(loadConfig(validEnv({ JOB_CONCURRENCY: "0" })).jobs.concurrency).toBe(0);
    expect(loadConfig(validEnv({ JOB_CONCURRENCY: "5" })).jobs.concurrency).toBe(5);
    expect(() => loadConfig(validEnv({ JOB_CONCURRENCY: "-1" }))).toThrow(/JOB_CONCURRENCY/);
    expect(() => loadConfig(validEnv({ JOB_CONCURRENCY: "two" }))).toThrow(/JOB_CONCURRENCY/);
  });

  it("acceptsARawPemPrivateKey", () => {
    expect(loadConfig(validEnv({ GITHUB_APP_PRIVATE_KEY: PEM })).github.privateKey).toBe(PEM);
  });

  it("parsesOptionalListsAndOverrides", () => {
    const c = loadConfig(
      validEnv({
        ALLOWED_GITHUB_ACCOUNTS: " Acme, other-org ,",
        GEMINI_MODELS: "m-1, m-2",
        GEMINI_API_KEY: "instance-key",
        MONGODB_DB: "custom",
        GITHUB_API_URL: "https://ghe.example.com/api/v3/",
        GITHUB_WEB_URL: "https://ghe.example.com/",
      })
    );
    expect(c.allowedAccounts).toEqual(["acme", "other-org"]);
    expect(c.gemini.models).toEqual(["m-1", "m-2"]);
    expect(c.gemini.apiKey).toBe("instance-key");
    expect(c.mongodb.dbName).toBe("custom");
    expect(c.github.apiUrl).toBe("https://ghe.example.com/api/v3");
    expect(c.github.webUrl).toBe("https://ghe.example.com");
  });
});
