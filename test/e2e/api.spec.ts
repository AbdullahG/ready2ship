import { expect, test } from "@playwright/test";
import { E2E, STACK_CONTROL } from "./ports";
import { dbDocs, installApp, installOnGitHub, loginAs, openPullRequest, resetStack, seedUser } from "./helpers";

const ORIGIN = { origin: E2E.baseUrl };

test.beforeEach(resetStack);

test("A-07 unauthenticated API calls get 401", async ({ request }) => {
  expect((await request.get("/api/workspaces")).status()).toBe(401);
  expect((await request.get("/api/w/000000000000000000000000/pulls")).status()).toBe(401);
  expect((await request.put("/api/w/000000000000000000000000/ai-key", { headers: ORIGIN, data: { key: "x" } })).status()).toBe(401);
});

test("A-01 the GitHub token is stored encrypted at sign-in", async ({ page }) => {
  await loginAs(page, "alice");
  const [user] = await dbDocs<Record<string, unknown>>("users");
  expect(user.githubAccessToken).toBeUndefined();
  expect(user.encryptedAccessToken).toMatchObject({ v: 1, iv: expect.any(String), ct: expect.any(String) });
  expect(JSON.stringify(user)).not.toContain("utok-");
});

test("A-02 a member of one workspace cannot read another workspace", async ({ browser }) => {
  const aliceCtx = await browser.newContext();
  const alice = await aliceCtx.newPage();
  await loginAs(alice, "alice");
  const wsA = await installApp(alice, { installationId: 101, account: "team-a", owner: "alice" });

  const bobCtx = await browser.newContext();
  const bob = await bobCtx.newPage();
  await loginAs(bob, "bob");
  const wsB = await installApp(bob, { installationId: 202, account: "team-b", owner: "bob" });
  await openPullRequest(bob, { installationId: 202, repo: "team-b/secret", number: 1, title: "Secret PR" });
  await expect.poll(async () => (await dbDocs("pull_requests")).length).toBe(1);
  const [prB] = await dbDocs<{ _id: string }>("pull_requests");
  const [memberB] = await dbDocs<{ _id: string }>("memberships").then((m) =>
    m.filter((x) => (x as { githubLogin?: string }).githubLogin === "bob")
  );

  const r = alice.request;
  expect((await r.get(`/api/w/${wsA}/pulls`)).status()).toBe(200);
  for (const url of [
    `/api/w/${wsB}/pulls`,
    `/api/w/${wsB}/pulls/${prB._id}`,
    `/api/w/${wsA}/pulls/${prB._id}`, // B's PR through A's workspace
    `/api/w/${wsB}/members`,
    `/api/w/${wsB}/ai-key`,
  ]) {
    expect((await r.get(url)).status(), url).toBe(404);
  }
  expect((await r.delete(`/api/w/${wsB}/members/${memberB._id}`, { headers: ORIGIN })).status()).toBe(404);
  expect((await r.delete(`/api/w/${wsA}/members/${memberB._id}`, { headers: ORIGIN })).status()).toBe(404);

  const list = await (await r.get("/api/workspaces")).json();
  expect(list.workspaces.map((w: { account: string }) => w.account)).toEqual(["team-a"]);

  await alice.goto(`/w/${wsB}/pulls`);
  await expect(alice.getByText("Secret PR")).toHaveCount(0);
  await expect(alice.getByRole("heading", { name: /404|not found/i })).toBeVisible();
  await aliceCtx.close();
  await bobCtx.close();
});

test("A-03 members get 403 on owner-only actions", async ({ browser }) => {
  const ownerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  await loginAs(owner, "alice");
  const ws = await installApp(owner, { installationId: 101, account: "team-a", owner: "alice" });
  await seedUser("bob");
  expect((await owner.request.post(`/api/w/${ws}/members`, { headers: ORIGIN, data: { login: "bob" } })).status()).toBe(201);

  const memberCtx = await browser.newContext();
  const member = await memberCtx.newPage();
  await loginAs(member, "bob");
  const r = member.request;
  const members = (await (await r.get(`/api/w/${ws}/members`)).json()).members as Array<{ id: string; login: string }>;
  const aliceId = members.find((m) => m.login === "alice")!.id;

  expect((await r.get(`/api/w/${ws}/pulls`)).status()).toBe(200);
  // A-03b: members see whether the key works, nothing about the key itself.
  expect((await owner.request.put(`/api/w/${ws}/ai-key`, { headers: ORIGIN, data: { key: "AIza-fake-valid-key-1234" } })).status()).toBe(200);
  const memberView = await (await r.get(`/api/w/${ws}/ai-key`)).json();
  expect(memberView.ai).toEqual({ provider: "gemini", keyStatus: "valid", usingInstanceKey: false });
  expect((await (await owner.request.get(`/api/w/${ws}/ai-key`)).json()).ai.keyLast4).toBe("1234");
  expect((await r.put(`/api/w/${ws}/ai-key`, { headers: ORIGIN, data: { key: "AIza-fake-valid-key-1234" } })).status()).toBe(403);
  expect((await r.delete(`/api/w/${ws}/ai-key`, { headers: ORIGIN })).status()).toBe(403);
  expect((await r.post(`/api/w/${ws}/members`, { headers: ORIGIN, data: { login: "carol" } })).status()).toBe(403);
  expect((await r.patch(`/api/w/${ws}/members/${aliceId}`, { headers: ORIGIN, data: { role: "member" } })).status()).toBe(403);
  expect((await r.delete(`/api/w/${ws}/members/${aliceId}`, { headers: ORIGIN })).status()).toBe(403);
  const [workspace] = await dbDocs<{ ai: { keyStatus: string; keyLast4: string } }>("workspaces");
  expect(workspace.ai.keyLast4).toBe("1234"); // the member's PUT/DELETE changed nothing
  await ownerCtx.close();
  await memberCtx.close();
});

test("A-04 the setup URL refuses an installation the user cannot access", async ({ page }) => {
  await loginAs(page, "mallory");
  await fetch(`http://127.0.0.1:${E2E.githubPort}/__control/installation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: 303, accountLogin: "victim-org", accessibleBy: ["victim"] }),
  });

  const res = await page.goto("/api/github/setup?installation_id=303&setup_action=install");
  expect(res!.status()).toBe(403);
  await expect(page.getByTestId("setup-error")).toContainText("doesn't have access");
  expect(await dbDocs("workspaces")).toHaveLength(0);
});

test("A-05 an expired GitHub token sends the user through login and back to setup", async ({ page }) => {
  await loginAs(page, "alice");
  await installOnGitHub(page, { installationId: 404, account: "team-a", owner: "alice" });
  await fetch(`${STACK_CONTROL}/expire-tokens`, { method: "POST" });

  // The setup URL detects the 401, re-runs OAuth (fake auto-approves alice)
  // and lands back on setup, which now succeeds.
  await page.goto("/api/github/setup?installation_id=404&setup_action=install");
  await expect(page).toHaveURL(/\/w\/[a-f0-9]{24}\/onboarding$/);
  expect(await dbDocs("workspaces")).toHaveLength(1);
});

test("A-06 mutating requests from another origin are rejected", async ({ page }) => {
  await loginAs(page, "alice");
  const ws = await installApp(page, { installationId: 101, account: "team-a", owner: "alice" });
  const r = page.request;
  for (const headers of [{ origin: "https://evil.example" }, {}] as Array<Record<string, string>>) {
    expect((await r.put(`/api/w/${ws}/ai-key`, { headers, data: { key: "AIza-fake-valid-key-1234" } })).status()).toBe(403);
    expect((await r.post(`/api/w/${ws}/members`, { headers, data: { login: "bob" } })).status()).toBe(403);
  }
  const [workspace] = await dbDocs<{ ai: { keyStatus: string } }>("workspaces");
  expect(workspace.ai.keyStatus).toBe("missing");

  // Another site can't sign the user out either.
  expect((await r.post("/api/auth/logout", { headers: { origin: "https://evil.example" }, maxRedirects: 0 })).status()).toBe(403);
  expect((await r.get("/api/workspaces")).status()).toBe(200);
});

test("A-08 the setup URL never grants owner to someone who merely can see the installation", async ({ browser }) => {
  const ownerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  await loginAs(owner, "alice");
  // bob and carol can read a repository in the org, so GitHub lists the installation for them.
  const ws = await installApp(owner, { installationId: 101, account: "team-a", owner: "alice", accessibleBy: ["alice", "bob", "carol"] });
  await seedUser("bob");
  await owner.request.post(`/api/w/${ws}/members`, { headers: ORIGIN, data: { login: "bob" } });

  // A non-member is turned away and gets no membership.
  const carolCtx = await browser.newContext();
  const carol = await carolCtx.newPage();
  await loginAs(carol, "carol");
  const res = await carol.goto("/api/github/setup?installation_id=101&setup_action=update");
  expect(res!.status()).toBe(403);
  await expect(carol.getByTestId("setup-error")).toContainText("Ask a workspace owner to invite you");

  // An existing member stays a member.
  const bobCtx = await browser.newContext();
  const bob = await bobCtx.newPage();
  await loginAs(bob, "bob");
  await bob.goto("/api/github/setup?installation_id=101&setup_action=update");
  await expect(bob).toHaveURL(new RegExp(`/w/${ws}$`));

  const members = await dbDocs<{ githubLogin: string; role: string; status: string }>("memberships");
  expect(members.map((m) => [m.githubLogin, m.role, m.status]).sort()).toEqual([
    ["alice", "owner", "active"],
    ["bob", "member", "active"],
  ]);
  await ownerCtx.close();
  await carolCtx.close();
  await bobCtx.close();
});

test("A-09 if the setup redirect beats the webhook, the installer waits until it arrives", async ({ page }) => {
  await loginAs(page, "alice");
  await installOnGitHub(page, { installationId: 505, account: "team-a", owner: "alice" }, { sendWebhook: false });

  const res = await page.goto("/api/github/setup?installation_id=505&setup_action=install");
  expect(res!.status()).toBe(200);
  await expect(page.getByTestId("setup-waiting")).toBeVisible();
  expect(await dbDocs("memberships")).toHaveLength(0);

  // The webhook arrives; the page's refresh then lands in onboarding.
  const [alice] = await dbDocs<{ githubId: number }>("users");
  const { sendWebhook } = await import("./helpers");
  await sendWebhook(page.request, "installation", {
    action: "created",
    installation: { id: 505, account: { id: 5050, login: "team-a", type: "Organization" } },
    sender: { id: alice.githubId, login: "alice" },
  });
  await expect(page).toHaveURL(/\/w\/[a-f0-9]{24}\/onboarding$/, { timeout: 15_000 });
});

test("A-09 installing on your own personal account works without waiting for the webhook", async ({ page }) => {
  await loginAs(page, "alice");
  const [alice] = await dbDocs<{ githubId: number }>("users");
  await fetch(`http://127.0.0.1:${E2E.githubPort}/__control/installation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: 606, accountLogin: "alice", accountType: "User", accountId: alice.githubId, accessibleBy: ["alice"] }),
  });
  await page.goto("/api/github/setup?installation_id=606&setup_action=install");
  await expect(page).toHaveURL(/\/w\/[a-f0-9]{24}\/onboarding$/);
});

test("A-10 a review left behind by a crashed worker is picked up and completed", async ({ page }) => {
  await loginAs(page, "alice");
  const ws = await installApp(page, { installationId: 101, account: "team-a", owner: "alice" });
  await page.request.put(`/api/w/${ws}/ai-key`, { headers: ORIGIN, data: { key: "AIza-fake-valid-key-1234" } });
  await fetch(`http://127.0.0.1:${E2E.githubPort}/__control/pr-files`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repo: "team-a/app",
      number: 9,
      files: [{ filename: "src/greet.ts", status: "modified", patch: "@@ -1,1 +1,2 @@\n x\n+y", additions: 1, deletions: 0 }],
    }),
  });

  // As if a worker claimed this job a while ago and then the process died.
  const longAgo = new Date(Date.now() - 60 * 60_000).toISOString();
  await fetch(`${STACK_CONTROL}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      deliveryId: "crashed-delivery",
      event: "pull_request",
      kind: "review",
      prKey: "101:team-a/app#9",
      status: "running",
      attempts: 1,
      maxAttempts: 4,
      runAfter: longAgo,
      lockedUntil: longAgo,
      createdAt: longAgo,
      updatedAt: longAgo,
      payload: {
        action: "opened",
        installation: { id: 101 },
        repository: { full_name: "team-a/app", id: 1 },
        pull_request: {
          number: 9, id: 90, title: "Survives a crash", body: "", user: { login: "dev", avatar_url: "" },
          head: { sha: "s9", ref: "feature", repo: { full_name: "team-a/app" } }, base: { ref: "main" }, html_url: "https://github.example/9",
        },
      },
    }),
  });

  await expect
    .poll(async () => (await dbDocs<{ deliveryId: string; status: string; attempts: number }>("jobs")).find((j) => j.deliveryId === "crashed-delivery"), { timeout: 15_000 })
    .toMatchObject({ status: "done", attempts: 2 });
  await page.goto(`/w/${ws}/pulls`);
  await expect(page.getByTestId("pulls-table")).toContainText("Survives a crash");
});

test("A-11 the health endpoint reports the worker and the queue", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ ok: true, worker: "running", queue: { pending: 0, running: 0, failedLast24h: 0 } });

  const later = new Date(Date.now() + 60 * 60_000).toISOString();
  await fetch(`${STACK_CONTROL}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deliveryId: "later", event: "pull_request", kind: "closed", prKey: "1:a/b#1", status: "pending", attempts: 0, maxAttempts: 4, runAfter: later, lockedUntil: null, createdAt: later, updatedAt: later, payload: {} }),
  });
  expect((await (await request.get("/api/health")).json()).queue).toEqual({ pending: 1, running: 0, failedLast24h: 0 });
});
