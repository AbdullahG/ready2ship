import { expect, test, type Page } from "@playwright/test";
import { createGitRepo, githubComments, installApp, loginAs, openPullRequest, openPullRequestAt, resetStack, scriptGemini, sendWebhook } from "./helpers";

// Review modes through the real app: .ready2ship.yml in the reviewed repo,
// a real checkout of the PR head, and the dashboard showing what ran.
const VALID = "AIza-fake-valid-key-1234";
const REPO = "team-a/app";
const GREET_BEFORE = "export function greet(name) {\n  return name;\n}\n";
const GREET_AFTER = "export function greet(name) {\n  return name.trim();\n}\n";

test.beforeEach(resetStack);

async function ownerWithKey(page: Page): Promise<string> {
  await loginAs(page, "alice");
  const ws = await installApp(page, { installationId: 101, account: "team-a", owner: "alice" });
  await page.getByLabel("Gemini API key").fill(VALID);
  await page.getByRole("button", { name: "Save key" }).click();
  await expect(page.getByTestId("onboarding-ready")).toBeVisible();
  return ws;
}

const commentWith = (text: string) =>
  expect.poll(async () => (await githubComments()).find((c) => c.kind === "issue" && c.body.includes(text))?.body ?? "", { timeout: 15_000 });

test("DE-01 a repo set to dive gets an agentic review the dashboard shows", async ({ page }) => {
  const ws = await ownerWithKey(page);
  const heads = await createGitRepo(REPO, {
    base: { ".ready2ship.yml": "review:\n  mode: dive\n", "src/greet.ts": GREET_BEFORE },
    pulls: { 1: { "src/greet.ts": GREET_AFTER } },
  });
  await scriptGemini([
    { functionCalls: [{ name: "read_file", args: { path: "src/greet.ts" } }] },
    JSON.stringify({
      summary: "Trims names.",
      findings: [{ severity: "blocker", file: "src/greet.ts", startLine: 2, endLine: 2, description: "name can be null; trim() throws.", suggestion: "Guard it." }],
    }),
    JSON.stringify({ verdicts: [{ index: 0, keep: true }] }),
  ]);
  await openPullRequestAt(page, { installationId: 101, repo: REPO, number: 1, title: "Trim names", headSha: heads["1"] });
  await commentWith("🤿 Dive").toMatch(/🤿 Dive · 1 tool call · 1 file read · .*source: clone · config: \.ready2ship\.yml/);

  await page.goto(`/w/${ws}/pulls`);
  await page.getByTestId("pulls-table").getByRole("link", { name: "Trim names" }).click();
  await expect(page.getByTestId("review-mode")).toHaveText("Review:🤿 Dive");
  await expect(page.getByTestId("usage-tool-calls")).toHaveText("1");
  await expect(page.getByTestId("usage-files-read")).toHaveText("1");
  await expect(page.getByText("name can be null; trim() throws.")).toBeVisible();
});

test("DE-02 commenting @app dive on a lookout PR runs a dive of its head", async ({ page }) => {
  const ws = await ownerWithKey(page);
  const heads = await createGitRepo(REPO, { base: { "src/greet.ts": GREET_BEFORE }, pulls: { 2: { "src/greet.ts": GREET_AFTER } } });
  await openPullRequestAt(page, { installationId: 101, repo: REPO, number: 2, title: "Trim names", headSha: heads["2"] });
  await commentWith("🔭 Lookout").toContain("config: default");

  await scriptGemini([JSON.stringify({ summary: "Trims names.", findings: [] })]);
  await sendWebhook(page.request, "issue_comment", {
    action: "created",
    installation: { id: 101 },
    repository: { full_name: REPO },
    issue: { number: 2, pull_request: { url: "x" }, title: "Trim names", body: "", user: { login: "dev" } },
    comment: { id: 77, body: "@r2s-e2e dive", user: { login: "alice" }, author_association: "MEMBER" },
  });
  await commentWith("🤿 Dive").toContain("trigger: comment");

  await page.goto(`/w/${ws}/pulls`);
  await page.getByTestId("pulls-table").getByRole("link", { name: "Trim names" }).click();
  await expect(page.getByTestId("review-mode")).toHaveText("Review:🤿 Dive");
});

test("DE-03 a dive that runs out of budget is cancelled with its reason", async ({ page }) => {
  const ws = await ownerWithKey(page);
  const heads = await createGitRepo(REPO, {
    base: { ".ready2ship.yml": "review:\n  mode: dive\ndive:\n  maxInputTokens: 10\n", "src/greet.ts": GREET_BEFORE },
    pulls: { 3: { "src/greet.ts": GREET_AFTER } },
  });
  await openPullRequestAt(page, { installationId: 101, repo: REPO, number: 3, title: "Trim names", headSha: heads["3"] });
  await commentWith("Dive cancelled").toContain("used 0 of 10 input tokens before finishing");

  await page.goto(`/w/${ws}/pulls?status=cancelled`);
  const row = page.getByTestId("pulls-table").getByRole("row", { name: /Trim names/ });
  await expect(row).toContainText("Cancelled");
  await row.getByRole("link", { name: "Trim names" }).click();
  await expect(page.getByTestId("cancel-reason")).toHaveText("used 0 of 10 input tokens before finishing");
});

test("DE-04 settings explain that review modes live in .ready2ship.yml", async ({ page }) => {
  const ws = await ownerWithKey(page);
  await openPullRequest(page, { installationId: 101, repo: REPO, number: 4, title: "Unrelated" }); // a workspace in use
  await page.goto(`/w/${ws}/settings`);
  const section = page.getByRole("region", { name: "Review modes" });
  await expect(section).toContainText("Lookout");
  await expect(section).toContainText("Dive");
  await expect(section.getByTestId("review-modes-example")).toContainText("mode: dive");
});

test("DE-05 a review that couldn't run is retried with @app retry", async ({ page }) => {
  await loginAs(page, "alice");
  await installApp(page, { installationId: 101, account: "team-a", owner: "alice" });
  const heads = await createGitRepo(REPO, { base: { "src/greet.ts": GREET_BEFORE }, pulls: { 5: { "src/greet.ts": GREET_AFTER } } });
  await openPullRequestAt(page, { installationId: 101, repo: REPO, number: 5, title: "Trim names", headSha: heads["5"] });
  await commentWith("no AI key is configured").toContain("**To retry:** comment `@r2s-e2e retry`.");

  await page.getByLabel("Gemini API key").fill(VALID);
  await page.getByRole("button", { name: "Save key" }).click();
  await expect(page.getByTestId("onboarding-ready")).toBeVisible();

  await scriptGemini([JSON.stringify({ summary: "Trims names.", findings: [] })]);
  await sendWebhook(page.request, "issue_comment", {
    action: "created",
    installation: { id: 101 },
    repository: { full_name: REPO },
    issue: { number: 5, pull_request: { url: "x" }, title: "Trim names", body: "", user: { login: "dev" } },
    comment: { id: 78, body: "@r2s-e2e retry", user: { login: "alice" }, author_association: "MEMBER" },
  });
  await commentWith("Trims names.").toContain("🔭 Lookout");
});

test("DE-06 the PR page fits a phone screen", async ({ page }) => {
  const ws = await ownerWithKey(page);
  const long = `const greeting = [${Array.from({ length: 30 }, (_, i) => `"part${i}"`).join(", ")}].join(" ");`;
  await scriptGemini([
    JSON.stringify({
      summary: "Trims names.",
      findings: [{ severity: "blocker", file: "src/greet.ts", startLine: 2, endLine: 2, description: "A very long line follows.", suggestion: "Split it.", fix: { original: long, replacement: long } }],
    }),
  ]);
  await openPullRequest(page, { installationId: 101, repo: REPO, number: 6, title: "Trim names" });
  await commentWith("🔭 Lookout").toContain("config: default");
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`/w/${ws}/pulls`);
  await page.getByTestId("pulls-table").getByRole("link", { name: "Trim names" }).click();
  await expect(page.getByText("A very long line follows.")).toBeVisible();
  await page.screenshot({ path: "test-results/de-06-mobile.png", fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBe(0);
});
