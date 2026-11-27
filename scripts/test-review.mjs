import { createHmac } from "crypto";

const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";

if (!WEBHOOK_SECRET) {
  console.error("GITHUB_WEBHOOK_SECRET env var is missing");
  process.exit(1);
}

const [, , repoFullName, prNumber, installationId] = process.argv;

if (!repoFullName || !prNumber || !installationId) {
  console.error("Usage: node scripts/test-review.mjs owner/repo PR_NUMBER INSTALLATION_ID");
  process.exit(1);
}

const [owner, repo] = repoFullName.split("/");

const payload = JSON.stringify({
  action: "opened",
  installation: { id: parseInt(installationId) },
  repository: {
    full_name: repoFullName,
    id: 999,
  },
  pull_request: {
    number: parseInt(prNumber),
    id: parseInt(prNumber) * 1000,
    title: "Test PR",
    body: "This is a test PR.",
    user: { login: "test-user", avatar_url: "https://github.com/identicons/test.png" },
    head: { sha: "abc123def456", ref: "feature/test" },
    base: { ref: "main" },
    html_url: `https://github.com/${repoFullName}/pull/${prNumber}`,
  },
});

const sig = `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex")}`;

const res = await fetch(`${BASE_URL}/api/webhooks/github`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-github-event": "pull_request",
    "x-hub-signature-256": sig,
    "x-github-delivery": crypto.randomUUID(),
  },
  body: payload,
});

console.log("Status:", res.status);
console.log("Body:", await res.text());
