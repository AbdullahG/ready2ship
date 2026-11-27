// Per-file integration environment: a real mongod (in-memory), a fake GitHub
// and a fake Gemini, wired through the same env variables production uses.
// Runs before the test file imports app modules, so config() sees this env.
import { afterAll, beforeEach } from "vitest";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";
import { FakeGitHub } from "../fakes/github";
import { FakeGemini } from "../fakes/gemini";
import { testEnv } from "./env";

const mongo = await MongoMemoryServer.create();
const github = new FakeGitHub();
const gemini = new FakeGemini();
await github.start();
await gemini.start();

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

Object.assign(process.env, {
  NODE_ENV: "test",
  BASE_URL: "http://r2s.test",
  GITHUB_APP_ID: "4242",
  GITHUB_APP_SLUG: "r2s-test",
  GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
  GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
  GITHUB_CLIENT_ID: "test-client-id",
  GITHUB_CLIENT_SECRET: "test-client-secret",
  GITHUB_API_URL: github.apiUrl,
  GITHUB_WEB_URL: github.webUrl,
  MONGODB_URI: mongo.getUri(),
  MONGODB_DB: "r2s_test",
  SESSION_SECRET: randomBytes(32).toString("hex"),
  ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  GEMINI_BASE_URL: gemini.url,
  GEMINI_MODELS: "fake-primary,fake-fallback",
});
delete process.env.GEMINI_API_KEY;
delete process.env.ALLOWED_GITHUB_ACCOUNTS;

testEnv.github = github;
testEnv.gemini = gemini;

beforeEach(async () => {
  github.reset();
  gemini.reset();
  const { resetConfigForTests } = await import("@/lib/config");
  resetConfigForTests();
  const { getClientPromise } = await import("@/lib/db/client");
  const client = await getClientPromise();
  await client.db("r2s_test").dropDatabase();
  const { ensureIndexes } = await import("@/lib/db/collections");
  await ensureIndexes();
});

afterAll(async () => {
  const { getClientPromise } = await import("@/lib/db/client");
  await (await getClientPromise()).close();
  await github.stop();
  await gemini.stop();
  await mongo.stop();
});
