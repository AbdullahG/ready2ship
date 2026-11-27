import { describe, expect, it } from "vitest";
import {
  BACKOFF_MS,
  LEASE_MS,
  claimNext,
  complete,
  enqueue,
  fail,
  queueCounts,
  type EnqueueInput,
} from "@/lib/jobs/queue";
import { getJobsCollection } from "@/lib/db/collections";

const T0 = new Date("2026-11-18T10:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

let n = 0;
function job(overrides: Partial<EnqueueInput> = {}): EnqueueInput {
  n++;
  return {
    deliveryId: `d-${n}`,
    event: "pull_request",
    payload: { n },
    kind: "review",
    prKey: `1:acme/app#${n}`,
    maxAttempts: 4,
    ...overrides,
  };
}

const jobs = async () => (await getJobsCollection()).find({}).sort({ createdAt: 1 }).toArray();

describe("job queue", () => {
  it("Q-01 aRedeliveredWebhookCreatesOneJob", async () => {
    expect(await enqueue(job({ deliveryId: "same" }), T0)).toEqual({ queued: true });
    expect(await enqueue(job({ deliveryId: "same" }), T0)).toEqual({ queued: false });
    expect(await jobs()).toHaveLength(1);
  });

  it("Q-02 jobsAreClaimedOldestFirstAndNotBeforeRunAfter", async () => {
    await enqueue(job({ deliveryId: "old" }), T0);
    await enqueue(job({ deliveryId: "new" }), at(1));
    const first = await claimNext(at(2));
    expect(first).toMatchObject({ deliveryId: "old", status: "running", attempts: 1 });
    expect(first!.lockedUntil).toEqual(at(2 + LEASE_MS));

    await fail(first!, new Error("boom"), { retryable: true }, at(3));
    // Only "new" is due; "old" waits for its backoff.
    expect(await claimNext(at(4))).toMatchObject({ deliveryId: "new" });
    expect(await claimNext(at(5))).toBeNull();
    expect(await claimNext(at(3 + BACKOFF_MS[0]))).toMatchObject({ deliveryId: "old", attempts: 2 });
  });

  it("Q-03 aPullRequestRunsOneJobAtATimeWhileOthersProceed", async () => {
    await enqueue(job({ deliveryId: "a1", prKey: "1:acme/app#7", kind: "comment" }), T0);
    await enqueue(job({ deliveryId: "a2", prKey: "1:acme/app#7", kind: "comment" }), at(1));
    await enqueue(job({ deliveryId: "b1", prKey: "1:acme/app#8" }), at(2));

    expect(await claimNext(at(3))).toMatchObject({ deliveryId: "a1" });
    // a2 is blocked by a1; b1 is free.
    expect(await claimNext(at(4))).toMatchObject({ deliveryId: "b1" });
    expect(await claimNext(at(5))).toBeNull();

    const a1 = (await jobs()).find((j) => j.deliveryId === "a1")!;
    await complete(a1, at(6));
    expect(await claimNext(at(7))).toMatchObject({ deliveryId: "a2" });
  });

  it("Q-04 aJobWhoseLeaseExpiredIsReclaimed", async () => {
    await enqueue(job({ deliveryId: "crashy" }), T0);
    const first = await claimNext(at(1));
    expect(await claimNext(at(2))).toBeNull(); // still leased
    const again = await claimNext(at(1 + LEASE_MS + 1));
    expect(again).toMatchObject({ deliveryId: "crashy", attempts: 2 });
    expect(again!._id.equals(first!._id)).toBe(true);
  });

  it("Q-05 retriesBackOffThenFailAtMaxAttempts", async () => {
    await enqueue(job({ deliveryId: "flaky", maxAttempts: 4 }), T0);
    let now = T0.getTime();
    const runAfters: number[] = [];
    for (let attempt = 1; attempt <= 4; attempt++) {
      const claimed = await claimNext(new Date(now));
      expect(claimed, `attempt ${attempt}`).toMatchObject({ attempts: attempt });
      await fail(claimed!, new Error(`fail ${attempt}`), { retryable: true }, new Date(now));
      const [stored] = await jobs();
      if (attempt < 4) {
        runAfters.push(stored.runAfter.getTime() - now);
        now = stored.runAfter.getTime();
      } else {
        expect(stored).toMatchObject({ status: "failed", lastError: "fail 4" });
        expect(stored.finishedAt).toBeInstanceOf(Date);
      }
    }
    expect(runAfters).toEqual([BACKOFF_MS[0], BACKOFF_MS[1], BACKOFF_MS[2]]);
    expect(BACKOFF_MS.slice(0, 3)).toEqual([30_000, 120_000, 600_000]);
  });

  it("Q-05 aNonRetryableErrorFailsImmediately", async () => {
    await enqueue(job({ maxAttempts: 4 }), T0);
    const claimed = await claimNext(T0);
    await fail(claimed!, new Error("bad key"), { retryable: false }, T0);
    expect((await jobs())[0]).toMatchObject({ status: "failed", attempts: 1 });
  });

  it("Q-06 aNewPushSupersedesPendingReviewsButNotARunningOne", async () => {
    const key = "1:acme/app#9";
    await enqueue(job({ deliveryId: "r1", prKey: key }), T0);
    await claimNext(at(1)); // r1 running
    await enqueue(job({ deliveryId: "r2", prKey: key }), at(2));
    await enqueue(job({ deliveryId: "c1", prKey: key, kind: "comment" }), at(3));
    await enqueue(job({ deliveryId: "r3", prKey: key }), at(4));

    const byId = Object.fromEntries((await jobs()).map((j) => [j.deliveryId, j.status]));
    expect(byId).toEqual({ r1: "running", r2: "superseded", c1: "pending", r3: "pending" });
  });

  it("Q-07 finishedJobsExpireAfter14Days", async () => {
    const indexes = await (await getJobsCollection()).indexes();
    const ttl = indexes.find((i) => i.key.finishedAt === 1);
    expect(ttl?.expireAfterSeconds).toBe(14 * 24 * 3600);
  });

  it("countsQueueStateForHealth", async () => {
    await enqueue(job({ deliveryId: "running" }), T0);
    expect(await claimNext(at(1))).toMatchObject({ deliveryId: "running" });
    await enqueue(job({ deliveryId: "dead", maxAttempts: 1 }), at(2));
    const dead = await claimNext(at(3));
    expect(dead).toMatchObject({ deliveryId: "dead" });
    await fail(dead!, new Error("x"), { retryable: true }, at(4));
    await enqueue(job({ deliveryId: "waiting" }), at(5));
    expect(await queueCounts(at(6))).toEqual({ pending: 1, running: 1, failedLast24h: 1 });
  });
});

describe("job queue: edge cases", () => {
  const key = "1:acme/app#42";

  it("Q-15 anExpiredRunningJobIsReclaimedEvenWhenAnOlderJobOfThatPrIsDue", async () => {
    // Y fails and waits; X (same PR) is claimed; the process dies; both become due.
    await enqueue(job({ deliveryId: "Y", prKey: key, kind: "comment" }), T0);
    const y = await claimNext(at(1));
    await fail(y!, new Error("transient"), { retryable: true }, at(2));
    await enqueue(job({ deliveryId: "X", prKey: key, kind: "comment" }), at(3));
    expect(await claimNext(at(4))).toMatchObject({ deliveryId: "X" });

    const later = at(4 + LEASE_MS + BACKOFF_MS[2]);
    expect(await claimNext(later)).toMatchObject({ deliveryId: "X", attempts: 2 });
  });

  it("Q-16 aRetriedReviewIsSupersededByANewerReviewOfTheSamePr", async () => {
    await enqueue(job({ deliveryId: "A", prKey: key }), T0);
    const a = await claimNext(at(1));
    await enqueue(job({ deliveryId: "B", prKey: key }), at(2)); // A is running, so not superseded yet
    expect(await fail(a!, new Error("transient"), { retryable: true }, at(3))).toBe("superseded");

    const byId = Object.fromEntries((await jobs()).map((j) => [j.deliveryId, j.status]));
    expect(byId).toEqual({ A: "superseded", B: "pending" });
  });

  it("Q-17 aJobThatUsedItsLastAttemptIsNotReclaimedAfterItsLeaseExpires", async () => {
    await enqueue(job({ deliveryId: "fix", prKey: key, kind: "comment", maxAttempts: 1 }), T0);
    await claimNext(at(1)); // the process dies mid-job
    expect(await claimNext(at(1 + LEASE_MS + 1))).toBeNull();
    expect((await jobs())[0]).toMatchObject({ status: "failed", attempts: 1, lastError: expect.stringMatching(/lease expired/) });
  });

  it("Q-18 aWorkerThatLostItsLeaseCannotChangeTheJob", async () => {
    await enqueue(job({ deliveryId: "slow", prKey: key }), T0);
    const stale = await claimNext(at(1));
    const fresh = await claimNext(at(1 + LEASE_MS + 1));
    expect(fresh).toMatchObject({ attempts: 2 });

    await complete(stale!, at(2 + LEASE_MS));
    await fail(stale!, new Error("late"), { retryable: true }, at(2 + LEASE_MS));
    expect((await jobs())[0]).toMatchObject({ status: "running", attempts: 2, lastError: null });

    await complete(fresh!, at(3 + LEASE_MS));
    expect((await jobs())[0]).toMatchObject({ status: "done" });
  });
});
