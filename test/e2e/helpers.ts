import { createHmac } from "node:crypto";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { E2E, GEMINI_CONTROL, GITHUB_CONTROL, STACK_CONTROL } from "./ports";

export const PATCH = "@@ -1,2 +1,3 @@\n export function greet(name) {\n-  return name;\n+  return name.trim();\n+}";

async function post(url: string, body?: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${url} → ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export async function resetStack(): Promise<void> {
  await post(`${STACK_CONTROL}/reset`);
}

export async function dbDocs<T = Record<string, unknown>>(collection: string): Promise<T[]> {
  return (await fetch(`${STACK_CONTROL}/db/${collection}`)).json() as Promise<T[]>;
}

export async function seedUser(login: string): Promise<{ id: number; login: string }> {
  return (await post(`${GITHUB_CONTROL}/user`, { login })) as { id: number; login: string };
}

export async function githubComments(): Promise<Array<{ id: number; kind: string; body: string }>> {
  return (await fetch(`${GITHUB_CONTROL}/comments`)).json();
}

/** Full OAuth round trip through the fake GitHub authorize page. */
export async function loginAs(page: Page, login: string, returnTo?: string): Promise<void> {
  await seedUser(login);
  await post(`${GITHUB_CONTROL}/oauth-login`, { login });
  const url = returnTo ? `/api/auth/github?returnTo=${encodeURIComponent(returnTo)}` : "/api/auth/github";
  await page.goto(url);
  await expect(page).not.toHaveURL(/\/api\/auth|\/login/);
}

export function sign(body: string): string {
  return `sha256=${createHmac("sha256", E2E.webhookSecret).update(body).digest("hex")}`;
}

export async function sendWebhook(request: APIRequestContext, event: string, payload: unknown): Promise<void> {
  const body = JSON.stringify(payload);
  const res = await request.post("/api/webhooks/github", {
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-hub-signature-256": sign(body),
      "x-github-delivery": crypto.randomUUID(),
    },
    data: body,
  });
  expect(res.status()).toBe(200);
}

/**
 * What GitHub does when someone installs the app: the installation webhook,
 * then a browser redirect to the Setup URL. Returns the workspace id.
 */
export async function installApp(
  page: Page,
  input: { installationId: number; account: string; owner: string; accessibleBy?: string[] }
): Promise<string> {
  await installOnGitHub(page, input);
  await page.goto(`/api/github/setup?installation_id=${input.installationId}&setup_action=install`);
  await expect(page).toHaveURL(/\/w\/[a-f0-9]{24}/);
  return page.url().match(/\/w\/([a-f0-9]{24})/)![1];
}

/** The installation exists on GitHub and its "created" webhook has been delivered. */
export async function installOnGitHub(
  page: Page,
  input: { installationId: number; account: string; owner: string; accessibleBy?: string[] },
  opts: { sendWebhook?: boolean } = {}
): Promise<void> {
  const owner = await seedUser(input.owner);
  await post(`${GITHUB_CONTROL}/installation`, {
    id: input.installationId,
    accountLogin: input.account,
    accessibleBy: input.accessibleBy ?? [input.owner],
  });
  if (opts.sendWebhook === false) return;
  await sendWebhook(page.request, "installation", {
    action: "created",
    installation: { id: input.installationId, account: { id: input.installationId * 10, login: input.account, type: "Organization" } },
    sender: { id: owner.id, login: owner.login },
  });
}

export async function openPullRequest(
  page: Page,
  input: { installationId: number; repo: string; number: number; title: string }
): Promise<void> {
  await post(`${GITHUB_CONTROL}/pr-files`, {
    repo: input.repo,
    number: input.number,
    files: [{ filename: "src/greet.ts", status: "modified", patch: PATCH, additions: 2, deletions: 1 }],
  });
  await sendWebhook(page.request, "pull_request", {
    action: "opened",
    installation: { id: input.installationId },
    repository: { full_name: input.repo, id: 1 },
    pull_request: {
      number: input.number,
      id: input.number * 10,
      title: input.title,
      body: "",
      user: { login: "dev", avatar_url: "" },
      head: { sha: "sha1", ref: "feature", repo: { full_name: input.repo } },
      base: { ref: "main" },
      html_url: `https://github.example/${input.repo}/pull/${input.number}`,
    },
  });
}

/** A real git repository the app can check out, with one head commit per PR. Returns head SHAs. */
export async function createGitRepo(
  repo: string,
  spec: { base: Record<string, string>; pulls?: Record<number, Record<string, string | null>> }
): Promise<Record<string, string>> {
  return ((await post(`${GITHUB_CONTROL}/git-repo`, { repo, spec })) as { heads: Record<string, string> }).heads;
}

/** Queues Gemini responses: text, or { functionCalls: [{ name, args }] } turns. */
export async function scriptGemini(responses: unknown[]): Promise<void> {
  await post(`${GEMINI_CONTROL}/script`, { responses });
}

export function pullRequestPayload(input: { installationId: number; repo: string; number: number; title: string; headSha: string }) {
  return {
    number: input.number,
    id: input.number * 10,
    title: input.title,
    body: "",
    user: { login: "dev", avatar_url: "" },
    head: { sha: input.headSha, ref: "feature", repo: { full_name: input.repo } },
    base: { ref: "main" },
    html_url: `https://github.example/${input.repo}/pull/${input.number}`,
  };
}

/** A PR whose head exists in a git repo made with createGitRepo; GitHub also answers GET /pulls/{n} for it. */
export async function openPullRequestAt(
  page: Page,
  input: { installationId: number; repo: string; number: number; title: string; headSha: string }
): Promise<void> {
  await post(`${GITHUB_CONTROL}/pr-files`, {
    repo: input.repo,
    number: input.number,
    files: [{ filename: "src/greet.ts", status: "modified", patch: PATCH, additions: 2, deletions: 1 }],
  });
  const pr = pullRequestPayload(input);
  await post(`${GITHUB_CONTROL}/pull`, { repo: input.repo, pr });
  await sendWebhook(page.request, "pull_request", {
    action: "opened",
    installation: { id: input.installationId },
    repository: { full_name: input.repo, id: 1, default_branch: "main" },
    pull_request: pr,
  });
}
