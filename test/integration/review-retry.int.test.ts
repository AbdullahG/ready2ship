import { afterEach, describe, expect, it } from "vitest";
import { claimNext, LEASE_MS } from "@/lib/jobs/queue";
import { enqueueWebhook } from "@/lib/jobs/handlers";
import { processNextJob } from "@/lib/jobs/runner";
import { getJobsCollection, getPullsCollection } from "@/lib/db/collections";
import { GEMINI_KEYS } from "../fakes/gemini";
import { buildGitRepo, type GitRepo } from "../fakes/git-repo";
import { testEnv } from "./env";
import { makeWorkspace } from "./builders";
import type { Workspace } from "@/types";

// Reviews are retried once on a transient error; past that, the PR's summary says how to
// ask again ("@app retry"), and the command re-runs the review of the current head.
const REPO = "acme/app";
const PATCH = "@@ -1,3 +1,3 @@\n export function greet(name) {\n-  return name;\n+  return name.trim();\n }";
const T0 = new Date("2026-11-24T10:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const RETRY = "**To retry:** comment `@r2s-test retry`.";

let repo: GitRepo | null = null;
afterEach(() => {
  repo?.cleanup();
  repo = null;
});

async function setup(yml?: string): Promise<Workspace> {
  const ws = await makeWorkspace({ aiKey: GEMINI_KEYS.valid });
  testEnv.github.addInstallation({ id: ws.githubInstallationId, accountLogin: "acme" });
  repo = buildGitRepo({
    base: { "src/greet.ts": "export function greet(name) {\n  return name;\n}\n" },
    pulls: { 7: { "src/greet.ts": "export function greet(name) {\n  return name.trim();\n}\n" } },
  });
  testEnv.github.gitRepos.set(REPO, repo.gitDir);
  if (yml) testEnv.github.putFile(REPO, ".ready2ship.yml", "main", yml);
  testEnv.github.prFiles.set(`${REPO}#7`, [{ filename: "src/greet.ts", status: "modified", patch: PATCH, additions: 1, deletions: 1 }]);
  testEnv.github.setPull(REPO, pull());
  return ws;
}

function pull() {
  return {
    number: 7,
    id: 70,
    title: "Trim names",
    body: null,
    user: { login: "dev", avatar_url: "" },
    head: { sha: repo!.headSha(7), ref: "feature", repo: { full_name: REPO } },
    base: { ref: "main" },
    html_url: `https://github.example/${REPO}/pull/7`,
  };
}

const prOpened = (ws: Workspace) => ({
  action: "opened",
  installation: { id: ws.githubInstallationId },
  repository: { full_name: REPO, id: 1, default_branch: "main" },
  pull_request: pull(),
});

const comment = (ws: Workspace, body: string, association = "COLLABORATOR", id = 950) => ({
  action: "created",
  installation: { id: ws.githubInstallationId },
  repository: { full_name: REPO, default_branch: "main" },
  issue: { number: 7, pull_request: { url: "x" }, title: "Trim names", body: "", user: { login: "dev" } },
  comment: { id, body, user: { login: "teammate" }, author_association: association },
});

const summary = () => testEnv.github.comments.find((c) => c.kind === "issue")?.body ?? "";
const prDoc = async () => (await getPullsCollection()).findOne({ repoFullName: REPO, githubPrNumber: 7 });
const jobs = async () => (await getJobsCollection()).find().sort({ createdAt: 1 }).toArray();
const approve = () => testEnv.gemini.scripted.push(JSON.stringify({ summary: "Trims.", findings: [] }));

describe("retrying a review", () => {
  it("DI-27 aReviewIsRetriedOnceThenSaysHowToRetry", async () => {
    const ws = await setup();
    testEnv.gemini.failingModels.add("fake-primary").add("fake-fallback");
    await enqueueWebhook("pull_request", prOpened(ws), "d-open", T0);
    expect((await jobs())[0]).toMatchObject({ kind: "review", maxAttempts: 2 });

    expect(await processNextJob(at(1))).toBe("retry");
    expect(summary()).toContain("starting");
    expect(await processNextJob((await jobs())[0].runAfter)).toBe("done");
    expect(summary()).toContain("the AI review failed");
    expect(summary()).toContain(RETRY);
    expect(summary()).not.toContain("allow-empty");
  });

  it("DI-28 retryByAWriterReviewsTheCurrentHeadAgain", async () => {
    const ws = await setup();
    testEnv.gemini.failingModels.add("fake-primary").add("fake-fallback");
    await enqueueWebhook("pull_request", prOpened(ws), "d-open", T0);
    await processNextJob(at(1));
    await processNextJob((await jobs())[0].runAfter);
    expect(summary()).toContain(RETRY);

    testEnv.gemini.failingModels.clear();
    approve();
    expect(await enqueueWebhook("issue_comment", comment(ws, "@r2s-test retry"), "d-retry", at(3_600_000))).toEqual({ queued: true });
    expect((await jobs())[1]).toMatchObject({ kind: "retry", maxAttempts: 2, prKey: `${ws.githubInstallationId}:${REPO}#7` });
    expect(await processNextJob(at(3_600_001))).toBe("done");

    expect(testEnv.github.http.requests.some((r) => r.method === "POST" && r.path.endsWith("/issues/comments/950/reactions"))).toBe(true);
    expect(summary()).toContain("Trims.");
    expect(summary()).toContain("🔭 Lookout");
    expect(testEnv.github.reviews).toEqual([expect.objectContaining({ event: "APPROVE" })]);
    expect((await prDoc())?.status).toBe("approved");
  });

  it("DI-29 retryRepeatsARequestedDiveAsADive", async () => {
    const ws = await setup(); // no .ready2ship.yml: Lookout unless asked
    testEnv.gemini.failingModels.add("fake-primary").add("fake-fallback");
    await enqueueWebhook("issue_comment", comment(ws, "@r2s-test dive", "OWNER", 949), "d-dive", T0);
    await processNextJob(at(1));
    await processNextJob((await jobs())[0].runAfter);
    expect(summary()).toContain("🤿 **Ready2Ship Dive cancelled:**");
    expect(summary()).toContain(RETRY);

    testEnv.gemini.failingModels.clear();
    approve();
    await enqueueWebhook("issue_comment", comment(ws, "retry", "OWNER"), "d-retry", at(3_600_000));
    expect(await processNextJob(at(3_600_001))).toBe("done");
    expect(summary()).toMatch(/🤿 Dive · .* · trigger: comment/);
  });

  it("DI-29 retryOfAnAutomaticReviewLetsTheRepoConfigDecideAgain", async () => {
    const ws = await setup();
    testEnv.github.putFile(REPO, ".ready2ship.yml", "main", "review:\n  mode: turbo\n");
    await enqueueWebhook("pull_request", prOpened(ws), "d-open", T0);
    expect(await processNextJob(at(1))).toBe("done");
    expect(summary()).toContain("Fix it on the default branch, then comment `@r2s-test retry`.");

    testEnv.github.putFile(REPO, ".ready2ship.yml", "main", "review:\n  mode: lookout\n");
    approve();
    await enqueueWebhook("issue_comment", comment(ws, "@r2s-test retry"), "d-retry", at(60_000));
    expect(await processNextJob(at(60_001))).toBe("done");
    expect(summary()).toContain("🔭 Lookout");
    expect(summary()).not.toContain("trigger: comment");
  });

  it("DI-30 retryFromSomeoneWithoutWriteAccessIsIgnored", async () => {
    const ws = await setup();
    await enqueueWebhook("issue_comment", comment(ws, "@r2s-test retry", "CONTRIBUTOR"), "d-retry", T0);
    expect(await processNextJob(at(1))).toBe("done");
    expect(testEnv.gemini.calls).toHaveLength(0);
    expect(testEnv.github.comments).toHaveLength(0);
  });

  it("DI-31 aReviewWhoseWorkerDiedOnTheLastAttemptSaysItWasInterrupted", async () => {
    const ws = await setup();
    testEnv.gemini.failingModels.add("fake-primary").add("fake-fallback");
    await enqueueWebhook("pull_request", prOpened(ws), "d-open", T0);
    expect(await processNextJob(at(1))).toBe("retry");

    // The second (last) attempt is claimed and its worker dies: the lease runs out.
    const due = (await jobs())[0].runAfter;
    expect(await claimNext(due)).not.toBeNull();
    expect(await processNextJob(new Date(due.getTime() + LEASE_MS + 1))).toBeNull();

    expect((await jobs())[0].status).toBe("failed");
    expect(summary()).toBe(`⚠️ **Ready2Ship:** the review was interrupted before it finished.\n\n${RETRY}`);
    expect(await prDoc()).toMatchObject({ status: "cancelled", lastReview: { cancelledReason: "the review was interrupted before it finished" } });
  });

  it("DI-31 anUnexpectedErrorOnTheLastAttemptSaysItWasInterrupted", async () => {
    const ws = await setup();
    // Listing the PR's files fails with a non-retryable GitHub error.
    testEnv.github.failures.push({ method: "GET", path: /\/pulls\/7\/files/, status: 404, remaining: 5 });
    await enqueueWebhook("pull_request", prOpened(ws), "d-open", T0);
    expect(await processNextJob(at(1))).toBe("failed");
    expect(summary()).toContain("the review was interrupted before it finished");
    expect(summary()).toContain(RETRY);
  });

  it("DI-31 aReviewThatWasAlreadyPostedIsNotCalledInterrupted", async () => {
    const ws = await setup();
    approve();
    // The review goes out, then writing the final summary fails once: the job can't be retried safely.
    testEnv.github.failures.push({ method: "PATCH", path: /\/issues\/comments\/\d+$/, remaining: 1 });
    await enqueueWebhook("pull_request", prOpened(ws), "d-open", T0);
    expect(await processNextJob(at(1))).toBe("failed");
    expect(testEnv.github.reviews).toHaveLength(1);
    expect(summary()).not.toContain("interrupted");
    expect((await prDoc())?.status).not.toBe("cancelled");
  });
});
