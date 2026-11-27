// Boots the full local stack for Playwright: in-memory MongoDB, fake GitHub,
// fake Gemini, and the production build (`next start`) wired to them through
// the same env variables a real deployment uses. Also exposes a small control
// server so specs can reset state between tests.
import { spawn } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { FakeGitHub } from "../fakes/github";
import { FakeGemini } from "../fakes/gemini";
import { E2E } from "./ports";

const mongo = await MongoMemoryServer.create();
const github = new FakeGitHub();
const gemini = new FakeGemini();
await github.start(E2E.githubPort);
await gemini.start(E2E.geminiPort);
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

const env: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: "production",
  NEXT_MANUAL_SIG_HANDLE: "true", // as in the Docker image
  PORT: String(E2E.appPort),
  HOSTNAME: "127.0.0.1",
  BASE_URL: E2E.baseUrl,
  GITHUB_APP_ID: "4242",
  GITHUB_APP_SLUG: E2E.appSlug,
  GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
  GITHUB_WEBHOOK_SECRET: E2E.webhookSecret,
  GITHUB_CLIENT_ID: "e2e-client",
  GITHUB_CLIENT_SECRET: "e2e-secret",
  GITHUB_API_URL: github.apiUrl,
  GITHUB_WEB_URL: github.webUrl,
  MONGODB_URI: mongo.getUri(),
  MONGODB_DB: "r2s_e2e",
  SESSION_SECRET: randomBytes(32).toString("hex"),
  ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  GEMINI_BASE_URL: gemini.url,
  GEMINI_MODELS: "fake-primary",
};
delete env.GEMINI_API_KEY;
delete env.ALLOWED_GITHUB_ACCOUNTS;

const db = new MongoClient(mongo.getUri());
await db.connect();

const control = createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/reset") {
    github.reset();
    gemini.reset();
    const database = db.db("r2s_e2e");
    for (const c of await database.listCollections().toArray()) {
      await database.collection(c.name).deleteMany({});
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === "POST" && req.url === "/expire-tokens") {
    for (const t of github.userTokens.keys()) github.expiredTokens.add(t);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === "POST" && req.url === "/jobs") {
    // Insert a job as-is (e.g. one a crashed worker left "running").
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const job = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    for (const k of ["runAfter", "lockedUntil", "createdAt", "updatedAt"]) if (job[k]) job[k] = new Date(job[k]);
    await db.db("r2s_e2e").collection("jobs").insertOne({ finishedAt: null, lastError: null, progress: {}, ...job });
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === "GET" && req.url?.startsWith("/db/")) {
    const name = req.url.slice(4);
    const docs = await db.db("r2s_e2e").collection(name).find({}).toArray();
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(docs));
    return;
  }
  res.writeHead(404).end();
});
await new Promise<void>((r) => control.listen(E2E.controlPort, "127.0.0.1", r));

// Run the standalone server exactly like the Docker image does.
const standalone = ".next/standalone";
if (!existsSync(`${standalone}/server.js`)) throw new Error("Run `npm run build` first");
cpSync(".next/static", `${standalone}/.next/static`, { recursive: true });
cpSync("public", `${standalone}/public`, { recursive: true });
const app = spawn("node", ["server.js"], { cwd: standalone, env, stdio: "inherit" });

async function shutdown() {
  app.kill("SIGTERM");
  control.close();
  await db.close();
  await github.stop();
  await gemini.stop();
  await mongo.stop();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
app.on("exit", (code) => {
  console.error(`next start exited with ${code}`);
  void shutdown();
});
