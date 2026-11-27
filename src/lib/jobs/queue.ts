// Durable webhook job queue in MongoDB. Every function takes `now` so tests
// control time; production passes nothing and gets the real clock.
import { ObjectId } from "mongodb";
import { getJobsCollection } from "@/lib/db/collections";
import type { Job, JobKind } from "@/types";

/** How long a claimed job is reserved before another worker may take it over. */
export const LEASE_MS = 2 * 60_000;
/** Delay before attempt n+1, indexed by attempts made so far minus one. */
export const BACKOFF_MS = [30_000, 120_000, 600_000];
const MAX_CLAIM_CANDIDATES = 5;

export interface EnqueueInput {
  deliveryId: string | null;
  event: string;
  payload: unknown;
  kind: JobKind;
  prKey: string | null;
  maxAttempts: number;
}

const isDuplicateKey = (err: unknown) => (err as { code?: number }).code === 11000;

export async function enqueue(input: EnqueueInput, now = new Date()): Promise<{ queued: boolean }> {
  const jobs = await getJobsCollection();
  const _id = new ObjectId();
  try {
    await jobs.insertOne({
      _id,
      ...input,
      status: "pending",
      attempts: 0,
      runAfter: now,
      lockedUntil: null,
      progress: {},
      lastError: null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    });
  } catch (err) {
    if (isDuplicateKey(err)) return { queued: false };
    throw err;
  }

  // A newer push makes reviews of older commits pointless. Only jobs that
  // haven't started are dropped; a running review finishes first.
  if (input.kind === "review" && input.prKey) {
    await jobs.updateMany(
      { prKey: input.prKey, kind: "review", status: "pending", _id: { $ne: _id } },
      { $set: { status: "superseded", updatedAt: now, finishedAt: now } }
    );
  }
  return { queued: true };
}

/** The claim a worker holds: writes only apply while it still owns the job. */
export type Claim = Pick<Job, "_id" | "attempts">;
const owned = (c: Claim) => ({ _id: c._id, attempts: c.attempts, status: "running" as const });

/**
 * Atomically takes a due job. Expired leases come first: their worker died,
 * and they already hold their PR's "running" slot, so a pending job of the
 * same PR could never start before them. Jobs whose lease expired on their
 * last attempt are failed instead (a job that crashes the process must not
 * loop, and fix-it must never run twice). Then the oldest due pending job;
 * the partial unique index on running prKey rejects a second running job of
 * the same PR, which is skipped in favour of the next candidate.
 */
export async function claimNext(now = new Date()): Promise<Job | null> {
  const jobs = await getJobsCollection();
  const lease = { status: "running" as const, lockedUntil: new Date(now.getTime() + LEASE_MS), updatedAt: now };

  await failAbandoned(now);
  const reclaimed = await jobs.findOneAndUpdate(
    { status: "running", lockedUntil: { $lt: now } },
    { $set: lease, $inc: { attempts: 1 } },
    { sort: { createdAt: 1, _id: 1 }, returnDocument: "after" }
  );
  if (reclaimed) return reclaimed;

  const blockedPrKeys: string[] = [];
  for (let i = 0; i < MAX_CLAIM_CANDIDATES; i++) {
    try {
      return await jobs.findOneAndUpdate(
        {
          status: "pending",
          runAfter: { $lte: now },
          ...(blockedPrKeys.length > 0 ? { prKey: { $nin: blockedPrKeys } } : {}),
        },
        { $set: lease, $inc: { attempts: 1 } },
        { sort: { createdAt: 1, _id: 1 }, returnDocument: "after" }
      );
    } catch (err) {
      const prKey = (err as { keyValue?: { prKey?: string } }).keyValue?.prKey;
      if (!isDuplicateKey(err) || !prKey) throw err;
      blockedPrKeys.push(prKey);
    }
  }
  return null;
}

/** Fails jobs whose lease expired on their last attempt (their worker died) and returns them. */
export async function failAbandoned(now = new Date()): Promise<Job[]> {
  const jobs = await getJobsCollection();
  const abandoned: Job[] = [];
  for (;;) {
    const job = await jobs.findOneAndUpdate(
      { status: "running", lockedUntil: { $lt: now }, $expr: { $gte: ["$attempts", "$maxAttempts"] } },
      { $set: { status: "failed", lockedUntil: null, lastError: "lease expired after the final attempt", updatedAt: now, finishedAt: now } },
      { returnDocument: "after" }
    );
    if (!job) return abandoned;
    abandoned.push(job);
  }
}

export async function extendLease(claim: Claim, now = new Date()): Promise<void> {
  await (await getJobsCollection()).updateOne(owned(claim), {
    $set: { lockedUntil: new Date(now.getTime() + LEASE_MS), updatedAt: now },
  });
}

export async function markProgress(claim: Claim, patch: Job["progress"], now = new Date()): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: now };
  for (const [k, v] of Object.entries(patch)) set[`progress.${k}`] = v;
  await (await getJobsCollection()).updateOne(owned(claim), { $set: set });
}

export async function complete(claim: Claim, now = new Date()): Promise<void> {
  await (await getJobsCollection()).updateOne(owned(claim), {
    $set: { status: "done", lockedUntil: null, updatedAt: now, finishedAt: now },
  });
}

/**
 * Schedules a retry with backoff, or marks the job failed for good. A review
 * that would be retried while a newer review of the same PR exists is
 * superseded instead: retrying it would review an outdated commit.
 */
export async function fail(
  claim: Claim,
  err: unknown,
  opts: { retryable: boolean },
  now = new Date()
): Promise<"retry" | "failed" | "superseded"> {
  const jobs = await getJobsCollection();
  const job = await jobs.findOne(owned(claim));
  if (!job) return "failed"; // lost the lease: another worker owns the job now
  const lastError = (err as Error)?.message ?? String(err);

  if (opts.retryable && job.attempts < job.maxAttempts) {
    const newer =
      job.kind === "review" && job.prKey
        ? await jobs.findOne({ prKey: job.prKey, kind: "review", createdAt: { $gt: job.createdAt }, status: { $ne: "superseded" } })
        : null;
    if (newer) {
      await jobs.updateOne(owned(claim), {
        $set: { status: "superseded", lockedUntil: null, lastError, updatedAt: now, finishedAt: now },
      });
      return "superseded";
    }
    const delay = BACKOFF_MS[job.attempts - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
    await jobs.updateOne(owned(claim), {
      $set: { status: "pending", lockedUntil: null, runAfter: new Date(now.getTime() + delay), lastError, updatedAt: now },
    });
    return "retry";
  }
  await jobs.updateOne(owned(claim), {
    $set: { status: "failed", lockedUntil: null, lastError, updatedAt: now, finishedAt: now },
  });
  return "failed";
}

export async function queueCounts(now = new Date()): Promise<{ pending: number; running: number; failedLast24h: number }> {
  const jobs = await getJobsCollection();
  const [pending, running, failedLast24h] = await Promise.all([
    jobs.countDocuments({ status: "pending" }),
    jobs.countDocuments({ status: "running" }),
    jobs.countDocuments({ status: "failed", finishedAt: { $gte: new Date(now.getTime() - 24 * 3600_000) } }),
  ]);
  return { pending, running, failedLast24h };
}
