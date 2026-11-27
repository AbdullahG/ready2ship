import { afterEach, describe, expect, it } from "vitest";
import { getJobsCollection, getPullsCollection } from "@/lib/db/collections";
import { enqueueWebhook } from "@/lib/jobs/handlers";
import { processNextJob } from "@/lib/jobs/runner";
import { GEMINI_KEYS } from "../fakes/gemini";
import { buildGitRepo, type GitRepo } from "../fakes/git-repo";
import { testEnv } from "./env";
import { makeWorkspace } from "./builders";
import type { Workspace } from "@/types";

// "@app dive" on a PR in a repo without .ready2ship.yml (Lookout), through the real job queue.
const REPO = "acme/app";
const PATCH = "@@ -1,3 +1,3 @@\n export function greet(name) {\n-  return name;\n+  return name.trim();\n }";
const T0 = new Date("2026-11-21T10:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

let repo: GitRepo | null = null;
afterEach(() => {
  repo?.cleanup();
  repo = null;
});

async function setup(): Promise<Workspace> {
  const ws = await makeWorkspace({ aiKey: GEMINI_KEYS.valid });
  testEnv.github.addInstallation({ id: ws.githubInstallationId, accountLogin: "acme" });
  repo = buildGitRepo({
    base: { "src/greet.ts": "export function greet(name) {\n  return name;\n}\n" },
    pulls: { 7: { "src/greet.ts": "export function greet(name) {\n  return name.trim();\n}\n" } },
  });
  testEnv.github.gitRepos.set(REPO, repo.gitDir);
  testEnv.github.prFiles.set(`${REPO}#7`, [{ filename: "src/greet.ts", status: "modified", patch: PATCH, additions: 1, deletions: 1 }]);
  testEnv.github.setPull(REPO, {
    number: 7,
    id: 70,
    title: "Trim names",
    body: null,
    user: { login: "dev", avatar_url: "" },
    head: { sha: repo.headSha(7), ref: "feature", repo: { full_name: REPO } },
    base: { ref: "main" },
    html_url: `https://github.example/${REPO}/pull/7`,
  });
  return ws;
}

function diveComment(ws: Workspace, association: string, body = "@r2s-test dive") {
  return {
    action: "created",
    installation: { id: ws.githubInstallationId },
    repository: { full_name: REPO },
    issue: { number: 7, pull_request: { url: "x" }, title: "Trim names", body: "", user: { login: "dev" } },
    comment: { id: 901, body, user: { login: "teammate" }, author_association: association },
  };
}

const summary = () => testEnv.github.comments.find((c) => c.kind === "issue")?.body ?? "";
const jobs = async () => (await getJobsCollection()).find().sort({ createdAt: 1 }).toArray();

describe("@app dive", () => {
  it("DI-09 aCollaboratorGetsADiveOfTheCurrentHead", async () => {
    const ws = await setup();
    testEnv.gemini.scripted.push({ functionCalls: [{ name: "read_file", args: { path: "src/greet.ts" } }] }, JSON.stringify({ summary: "Trims.", findings: [] }));

    expect(await enqueueWebhook("issue_comment", diveComment(ws, "COLLABORATOR"), "d-dive", T0)).toEqual({ queued: true });
    expect((await jobs())[0]).toMatchObject({ kind: "dive", maxAttempts: 2, prKey: `${ws.githubInstallationId}:${REPO}#7` });
    expect(await processNextJob(at(1))).toBe("done");

    expect(testEnv.github.http.requests.some((r) => r.method === "POST" && r.path.endsWith("/issues/comments/901/reactions"))).toBe(true);
    expect(testEnv.gemini.generateCalls[0].tools).toContain("grep");
    expect(summary()).toMatch(/🤿 Dive · 1 tool call · 1 file read · .* · trigger: comment · config: default/);
    expect(testEnv.github.reviews).toEqual([expect.objectContaining({ event: "APPROVE" })]);
    const pr = await (await getPullsCollection()).findOne({ repoFullName: REPO, githubPrNumber: 7 });
    expect(pr?.headSha).toBe(repo!.headSha(7));
    expect(pr?.lastReview).toMatchObject({ mode: "dive", trigger: "comment", configSource: "default" });
  });

  it("DI-09 deepReviewInAReviewThreadWorksToo", async () => {
    const ws = await setup();
    testEnv.gemini.scripted.push(JSON.stringify({ summary: "Trims.", findings: [] }));
    const payload = {
      action: "created",
      installation: { id: ws.githubInstallationId },
      repository: { full_name: REPO },
      pull_request: { number: 7, title: "Trim names", body: "", head: { sha: repo!.headSha(7), ref: "feature" }, user: { login: "dev" } },
      comment: { id: 902, body: "deep review", user: { login: "teammate" }, in_reply_to_id: 5, author_association: "MEMBER" },
    };
    await enqueueWebhook("pull_request_review_comment", payload, "d-thread", T0);
    expect(await processNextJob(at(1))).toBe("done");
    expect(summary()).toContain("🤿 Dive");
    expect(testEnv.github.http.requests.some((r) => r.path.endsWith("/pulls/comments/902/reactions"))).toBe(true);
  });

  it("DI-10 someoneWithoutWriteAccessIsIgnored", async () => {
    const ws = await setup();
    await enqueueWebhook("issue_comment", diveComment(ws, "CONTRIBUTOR"), "d-x", T0);
    expect(await processNextJob(at(1))).toBe("done");
    expect(testEnv.gemini.calls).toHaveLength(0);
    expect(testEnv.github.comments).toHaveLength(0);
    expect(testEnv.github.http.requests.some((r) => r.path.includes("/reactions"))).toBe(false);
  });

  it("DI-11 aLaterPushDoesNotSupersedeARequestedDive", async () => {
    const ws = await setup();
    await enqueueWebhook("issue_comment", diveComment(ws, "OWNER"), "d-dive", T0);
    const push = {
      action: "synchronize",
      installation: { id: ws.githubInstallationId },
      repository: { full_name: REPO, id: 1 },
      pull_request: { number: 7, id: 70, title: "Trim names", body: "", user: { login: "dev", avatar_url: "" }, head: { sha: repo!.headSha(7), ref: "feature", repo: { full_name: REPO } }, base: { ref: "main" }, html_url: "x" },
    };
    await enqueueWebhook("pull_request", push, "d-push", at(1));
    expect((await jobs()).map((j) => [j.kind, j.status])).toEqual([
      ["dive", "pending"],
      ["review", "pending"],
    ]);
  });
});
