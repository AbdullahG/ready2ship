import { describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { enqueueWebhook } from "@/lib/jobs/handlers";
import { processNextJob } from "@/lib/jobs/runner";
import { BACKOFF_MS, LEASE_MS } from "@/lib/jobs/queue";
import { getFindingsCollection, getJobsCollection, getPullsCollection } from "@/lib/db/collections";
import { STARTING_BODY } from "@/lib/github/pipeline/format";
import { GEMINI_KEYS } from "../fakes/gemini";
import { testEnv } from "./env";
import { makeWorkspace } from "./builders";
import type { Job, Workspace } from "@/types";

const REPO = "acme/app";
const PATCH = "@@ -1,2 +1,3 @@\n export function greet(name) {\n-  return name;\n+  return name.trim();\n+}";
const T0 = new Date("2026-11-18T10:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

function seed(ws: Workspace) {
  testEnv.github.addInstallation({ id: ws.githubInstallationId, accountLogin: "acme" });
  testEnv.github.prFiles.set(`${REPO}#7`, [{ filename: "src/greet.ts", status: "modified", patch: PATCH, additions: 2, deletions: 1 }]);
}

function prOpened(ws: Workspace) {
  return {
    action: "opened",
    installation: { id: ws.githubInstallationId },
    repository: { full_name: REPO, id: 1 },
    pull_request: {
      number: 7,
      id: 70,
      title: "Add greet",
      body: "",
      user: { login: "dev", avatar_url: "" },
      head: { sha: "sha1", ref: "feature", repo: { full_name: REPO } },
      base: { ref: "main" },
      html_url: `https://github.example/${REPO}/pull/7`,
    },
  };
}

function reviewReply(ws: Workspace, body: string, inReplyTo: number) {
  return {
    action: "created",
    installation: { id: ws.githubInstallationId },
    repository: { full_name: REPO },
    pull_request: { number: 7, title: "Add greet", body: "", head: { sha: "sha1", ref: "feature" } },
    comment: { id: 900, body, user: { login: "maintainer" }, in_reply_to_id: inReplyTo, author_association: "MEMBER" },
  };
}

const summary = () => testEnv.github.comments.find((c) => c.kind === "issue")!.body;
const allJobs = async () => (await getJobsCollection()).find({}).sort({ createdAt: 1 }).toArray();

/** Opens the PR through the queue and runs that first review to completion. */
async function reviewedPr(ws: Workspace) {
  await enqueueWebhook("pull_request", prOpened(ws), "d-open", T0);
  await processNextJob(at(1));
  return (await (await getFindingsCollection()).findOne({}))!;
}

async function insertReclaimable(job: Partial<Job>) {
  await (await getJobsCollection()).insertOne({
    _id: new ObjectId(),
    deliveryId: null,
    event: "pull_request",
    kind: "review",
    payload: {},
    prKey: "x",
    status: "running",
    attempts: 1,
    maxAttempts: 4,
    runAfter: T0,
    lockedUntil: at(-1),
    progress: {},
    lastError: null,
    createdAt: T0,
    updatedAt: T0,
    finishedAt: null,
    ...job,
  } as Job);
}

describe("jobs: retries and idempotency", () => {
  it("Q-08 aTransientGeminiOutageIsRetriedWithoutTouchingThePrComment", async () => {
    const ws = await makeWorkspace({ aiKey: GEMINI_KEYS.valid });
    seed(ws);
    testEnv.gemini.outageCalls = 2; // both models fail once
    await enqueueWebhook("pull_request", prOpened(ws), "d1", T0);

    expect(await processNextJob(at(1))).toBe("retry");
    expect(summary()).toBe(STARTING_BODY);
    expect((await allJobs())[0]).toMatchObject({ status: "pending", attempts: 1 });
    expect((await (await getPullsCollection()).findOne({}))!.status).toBe("reviewing");

    expect(await processNextJob(at(2))).toBeNull(); // backoff not elapsed
    expect(await processNextJob(at(1 + BACKOFF_MS[0]))).toBe("done");
    expect(summary()).toContain("Review complete");
    expect(testEnv.github.reviews).toHaveLength(1);
  });

  it("Q-09 aRejectedKeyIsNotRetriedAndIsExplained", async () => {
    const ws = await makeWorkspace({ aiKey: GEMINI_KEYS.invalid });
    seed(ws);
    await enqueueWebhook("pull_request", prOpened(ws), "d1", T0);

    expect(await processNextJob(at(1))).toBe("done");
    expect(summary()).toContain("AI key was rejected");
    expect(await processNextJob(at(1 + LEASE_MS + BACKOFF_MS[2]))).toBeNull();
    expect(testEnv.gemini.generateCalls).toHaveLength(1);
  });

  it("Q-09 aMissingKeyIsNotRetried", async () => {
    const ws = await makeWorkspace();
    seed(ws);
    await enqueueWebhook("pull_request", prOpened(ws), "d1", T0);
    expect(await processNextJob(at(1))).toBe("done");
    expect(summary()).toContain("no AI key is configured");
    expect(await processNextJob(at(1 + LEASE_MS + BACKOFF_MS[2]))).toBeNull();
  });

  it("Q-10 aFailureAfterTheReviewWasPostedNeverPostsASecondReview", async () => {
    const ws = await makeWorkspace({ aiKey: GEMINI_KEYS.valid });
    seed(ws);
    // Updating the summary comment (after the review is submitted) fails.
    testEnv.github.failures.push({ method: "PATCH", path: /\/issues\/comments\/\d+$/, remaining: 5 });
    await enqueueWebhook("pull_request", prOpened(ws), "d1", T0);

    expect(await processNextJob(at(1))).toBe("failed");
    expect(await processNextJob(at(1 + LEASE_MS + BACKOFF_MS[2]))).toBeNull();
    expect(testEnv.github.reviews).toHaveLength(1);
    expect((await allJobs())[0]).toMatchObject({ status: "failed", progress: { reviewSubmitted: true } });
  });

  it("Q-11 aReclaimedJobWhoseReviewWasPostedIsCompletedWithoutRunning", async () => {
    const ws = await makeWorkspace({ aiKey: GEMINI_KEYS.valid });
    seed(ws);
    await insertReclaimable({ payload: prOpened(ws), progress: { reviewSubmitted: true } });

    expect(await processNextJob(at(1))).toBe("done");
    expect(testEnv.github.http.requests).toHaveLength(0);
    expect(testEnv.gemini.calls).toHaveLength(0);
  });

  it("Q-12 fixItIsNeverRetried", async () => {
    const ws = await makeWorkspace({ aiKey: GEMINI_KEYS.valid });
    seed(ws);
    const finding = await reviewedPr(ws);
    testEnv.github.failures.push({ method: "GET", path: /\/contents\//, remaining: 10 });
    await enqueueWebhook("pull_request_review_comment", reviewReply(ws, "fix it", finding.githubCommentId!), "d-fix", at(2));

    expect(await processNextJob(at(3))).toBe("failed");
    expect(await processNextJob(at(3 + LEASE_MS + BACKOFF_MS[2]))).toBeNull();
    expect(testEnv.github.commits).toHaveLength(0);
    expect((await allJobs()).find((j) => j.deliveryId === "d-fix")).toMatchObject({ attempts: 1, maxAttempts: 1 });
  });

  it("Q-13 quotaIsRetriedAndExplainedOnlyOnTheLastAttempt", async () => {
    const ws = await makeWorkspace({ aiKey: GEMINI_KEYS.quota });
    seed(ws);
    await enqueueWebhook("pull_request", prOpened(ws), "d1", T0);

    let now = at(1).getTime();
    // Reviews are retried once (changed on request 2026-11-24; was three times).
    for (let attempt = 1; attempt <= 1; attempt++) {
      expect(await processNextJob(new Date(now)), `attempt ${attempt}`).toBe("retry");
      expect(summary()).toBe(STARTING_BODY);
      now = (await allJobs())[0].runAfter.getTime();
    }
    expect(await processNextJob(new Date(now))).toBe("done");
    expect(summary()).toMatch(/quota/i);
  });

  it("Q-14 aReclaimedQuestionThatWasAnsweredIsNotAnsweredAgain", async () => {
    const ws = await makeWorkspace({ aiKey: GEMINI_KEYS.valid });
    seed(ws);
    await insertReclaimable({
      event: "pull_request_review_comment",
      kind: "comment",
      payload: reviewReply(ws, "why?", 1),
      progress: { replied: true },
      maxAttempts: 2,
    });
    expect(await processNextJob(at(1))).toBe("done");
    expect(testEnv.github.http.requests).toHaveLength(0);
  });

  it("Q-14 aQuestionRecordsThatItReplied", async () => {
    const ws = await makeWorkspace({ aiKey: GEMINI_KEYS.valid });
    seed(ws);
    const finding = await reviewedPr(ws);
    testEnv.gemini.scripted.push("Because.");
    await enqueueWebhook("pull_request_review_comment", reviewReply(ws, "why?", finding.githubCommentId!), "d-q", at(2));

    expect(await processNextJob(at(3))).toBe("done");
    expect((await allJobs()).find((j) => j.deliveryId === "d-q")).toMatchObject({ progress: { replied: true }, maxAttempts: 2 });
  });

  it("routesOnlyEventsThatNeedWork", async () => {
    const ws = await makeWorkspace({ aiKey: GEMINI_KEYS.valid });
    const ignored = [
      ["pull_request", { ...prOpened(ws), action: "labeled" }],
      ["issue_comment", { action: "created", installation: { id: 1 }, repository: { full_name: REPO }, issue: { number: 7, title: "", body: "" }, comment: { id: 1, body: "why?", user: { login: "x" } } }],
      ["issue_comment", { action: "created", installation: { id: 1 }, repository: { full_name: REPO }, issue: { number: 7, pull_request: {}, title: "", body: "" }, comment: { id: 1, body: "thanks", user: { login: "x" } } }],
      // the bot's own answers contain "?" too
      ["pull_request_review_comment", { ...reviewReply(ws, "why?", 1), comment: { ...reviewReply(ws, "why?", 1).comment, user: { login: "r2s-test[bot]" } } }],
      ["star", {}],
    ] as const;
    for (const [event, payload] of ignored) {
      expect(await enqueueWebhook(event, payload, null, T0), event).toEqual({ queued: false });
    }
    expect(await allJobs()).toHaveLength(0);

    await enqueueWebhook("pull_request", { ...prOpened(ws), action: "closed" }, "c", T0);
    await enqueueWebhook("pull_request_review_thread", { action: "resolved", installation: { id: 1 }, repository: { full_name: REPO }, pull_request: { number: 7, head: { sha: "s", ref: "f" } }, thread: { comments: [] } }, "t", T0);
    expect((await allJobs()).map((j) => [j.kind, j.prKey, j.maxAttempts])).toEqual([
      ["closed", `${ws.githubInstallationId}:${REPO}#7`, 4],
      ["thread", `1:${REPO}#7`, 4],
    ]);
  });
});
