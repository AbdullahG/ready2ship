import { afterEach, describe, expect, it } from "vitest";
import { shutdownGracefully, startWorker, startConfiguredWorker, wakeWorker, workerStatus, type Worker } from "@/lib/jobs/worker";
import { enqueueWebhook } from "@/lib/jobs/handlers";
import { getFindingsCollection, getJobsCollection } from "@/lib/db/collections";
import { resetConfigForTests } from "@/lib/config";
import { GEMINI_KEYS } from "../fakes/gemini";
import { testEnv } from "./env";
import { makeWorkspace } from "./builders";
import type { Workspace } from "@/types";

const REPO = "acme/app";
const PATCH = "@@ -1,2 +1,3 @@\n export function greet(name) {\n-  return name;\n+  return name.trim();\n+}";

let worker: Worker | null = null;
afterEach(async () => {
  await worker?.stop();
  worker = null;
});

function seed(ws: Workspace, numbers: number[]) {
  testEnv.github.addInstallation({ id: ws.githubInstallationId, accountLogin: "acme" });
  for (const n of numbers) {
    testEnv.github.prFiles.set(`${REPO}#${n}`, [{ filename: "src/greet.ts", status: "modified", patch: PATCH, additions: 2, deletions: 1 }]);
  }
}

function prOpened(ws: Workspace, number: number) {
  return {
    action: "opened",
    installation: { id: ws.githubInstallationId },
    repository: { full_name: REPO, id: 1 },
    pull_request: {
      number,
      id: number * 10,
      title: `PR ${number}`,
      body: "",
      user: { login: "dev", avatar_url: "" },
      head: { sha: "sha1", ref: "feature", repo: { full_name: REPO } },
      base: { ref: "main" },
      html_url: `https://github.example/${REPO}/pull/${number}`,
    },
  };
}

const jobStatuses = async () => (await (await getJobsCollection()).find({}).sort({ createdAt: 1 }).toArray()).map((j) => j.status);

describe("worker", () => {
  it("W-01 processesAQueuedReviewEndToEnd", async () => {
    const ws = await makeWorkspace({ aiKey: GEMINI_KEYS.valid });
    seed(ws, [1]);
    worker = startWorker({ concurrency: 1, pollMs: 20 });
    await enqueueWebhook("pull_request", prOpened(ws, 1), "d1");

    await expect.poll(jobStatuses, { timeout: 10_000 }).toEqual(["done"]);
    expect(testEnv.github.reviews).toHaveLength(1);
    expect(await (await getFindingsCollection()).countDocuments({})).toBe(1);
  });

  it("W-02 stopFinishesTheRunningJobAndTakesNoNewOnes", async () => {
    const ws = await makeWorkspace({ aiKey: GEMINI_KEYS.valid });
    seed(ws, [1, 2]);
    testEnv.gemini.latencyMs = 300;
    worker = startWorker({ concurrency: 1, pollMs: 20 });
    await enqueueWebhook("pull_request", prOpened(ws, 1), "d1");
    await expect.poll(() => testEnv.gemini.generateCalls.length, { timeout: 10_000 }).toBe(1);

    await worker.stop();
    expect(await jobStatuses()).toEqual(["done"]);

    await enqueueWebhook("pull_request", prOpened(ws, 2), "d2");
    // stop() resolved, so nothing can be running; the new job stays queued.
    expect(await jobStatuses()).toEqual(["done", "pending"]);
    expect(workerStatus()).toBe("disabled");
  });

  it("W-03 differentPullRequestsRunInParallelAndOnePullRequestInOrder", async () => {
    const ws = await makeWorkspace({ aiKey: GEMINI_KEYS.valid });
    seed(ws, [1, 2]);
    testEnv.gemini.latencyMs = 300;
    await enqueueWebhook("pull_request", prOpened(ws, 1), "a");
    await enqueueWebhook("pull_request", prOpened(ws, 2), "b");
    await enqueueWebhook(
      "issue_comment",
      {
        action: "created",
        installation: { id: ws.githubInstallationId },
        repository: { full_name: REPO },
        issue: { number: 1, pull_request: { url: "x" }, title: "PR 1", body: "" },
        comment: { id: 5, body: "why?", user: { login: "teammate" }, author_association: "MEMBER" },
      },
      "c"
    );
    worker = startWorker({ concurrency: 2, pollMs: 20 });
    await expect.poll(jobStatuses, { timeout: 15_000 }).toEqual(["done", "done", "done"]);

    // Slots race for the queue, so find each call by content, not position.
    const calls = testEnv.gemini.generateCalls;
    expect(calls).toHaveLength(3);
    const question = calls.find((c) => c.prompt.includes("why?"))!;
    const pr1 = calls.find((c) => c !== question && c.prompt.includes("PR title: PR 1"))!;
    const pr2 = calls.find((c) => c.prompt.includes("PR title: PR 2"))!;
    // PR 1 and PR 2 overlapped…
    expect(Math.max(pr1.startedAt, pr2.startedAt)).toBeLessThan(Math.min(pr1.endedAt!, pr2.endedAt!));
    // …but the question on PR 1 waited for PR 1's review.
    expect(question.startedAt).toBeGreaterThanOrEqual(pr1.endedAt!);
  });

  it("W-04 jobConcurrencyZeroLeavesTheWorkerOff", async () => {
    process.env.JOB_CONCURRENCY = "0";
    resetConfigForTests();
    try {
      expect(startConfiguredWorker()).toBeNull();
      expect(workerStatus()).toBe("disabled");
    } finally {
      delete process.env.JOB_CONCURRENCY;
      resetConfigForTests();
    }
  });

  it("W-04 startConfiguredWorkerIsASingleton", async () => {
    const first = startConfiguredWorker();
    const second = startConfiguredWorker();
    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(workerStatus()).toBe("running");
    worker = first;
  });
});

describe("worker wake-up", () => {
  it("W-05 aJobQueuedInThisProcessStartsWithoutWaitingForThePoll", async () => {
    const ws = await makeWorkspace({ aiKey: GEMINI_KEYS.valid });
    seed(ws, [1]);
    worker = startWorker({ concurrency: 1, pollMs: 60_000 });
    // Let the loop find the queue empty and go idle for a minute.
    await expect.poll(() => workerStatus()).toBe("running");
    await new Promise((r) => setImmediate(r));

    await enqueueWebhook("pull_request", prOpened(ws, 1), "d1");
    wakeWorker();
    await expect.poll(jobStatuses, { timeout: 3_000 }).toEqual(["done"]);
  });
});

describe("graceful shutdown", () => {
  it("W-06 onShutdownStopsTakingJobsFinishesTheRunningOneThenExits", async () => {
    const ws = await makeWorkspace({ aiKey: GEMINI_KEYS.valid });
    seed(ws, [1, 2]);
    testEnv.gemini.latencyMs = 400;
    worker = startWorker({ concurrency: 1, pollMs: 20 });
    await enqueueWebhook("pull_request", prOpened(ws, 1), "d1");
    await expect.poll(() => testEnv.gemini.generateCalls.length, { timeout: 5_000 }).toBe(1);

    const exits: number[] = [];
    const statusesAtExit: string[][] = [];
    await shutdownGracefully("SIGTERM", {
      worker,
      drainMs: 5_000,
      exit: async (code: number) => {
        exits.push(code);
        statusesAtExit.push(await jobStatuses());
      },
    });
    await enqueueWebhook("pull_request", prOpened(ws, 2), "d2");

    expect(exits).toEqual([143]);
    expect(statusesAtExit).toEqual([["done"]]);
    expect(await jobStatuses()).toEqual(["done", "pending"]);
    worker = null;
  });

  it("W-07 aJobLongerThanTheDrainWindowDoesNotBlockExit", async () => {
    const ws = await makeWorkspace({ aiKey: GEMINI_KEYS.valid });
    seed(ws, [1]);
    testEnv.gemini.latencyMs = 3_000;
    worker = startWorker({ concurrency: 1, pollMs: 20 });
    await enqueueWebhook("pull_request", prOpened(ws, 1), "d1");
    await expect.poll(() => testEnv.gemini.generateCalls.length, { timeout: 5_000 }).toBe(1);

    const started = Date.now();
    const exits: number[] = [];
    await shutdownGracefully("SIGINT", { worker, drainMs: 300, exit: async (code: number) => void exits.push(code) });
    expect(exits).toEqual([130]);
    expect(Date.now() - started).toBeLessThan(1_500);
    // The cut-short job stays running; its lease expiry hands it to the next process.
    expect(await jobStatuses()).toEqual(["running"]);
    await worker.stop();
    worker = null;
  });
});

describe("wake-up while busy", () => {
  it("W-08 aWakeUpThatArrivesMidClaimIsNotLost", async () => {
    let calls = 0;
    let finishFirstClaim!: (v: null) => void;
    const processNext = () => {
      calls++;
      if (calls === 1) return new Promise<null>((resolve) => (finishFirstClaim = resolve));
      return Promise.resolve(null);
    };
    worker = startWorker({ concurrency: 1, pollMs: 60_000, processNext });
    await expect.poll(() => calls).toBe(1);

    worker.wake(); // the loop is busy claiming: nobody is asleep yet
    finishFirstClaim(null); // the claim found nothing; the loop would now sleep a minute

    await expect.poll(() => calls, { timeout: 1_000 }).toBe(2);
  });
});
