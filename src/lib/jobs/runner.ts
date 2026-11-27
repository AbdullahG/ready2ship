import { alreadyDone, runJob } from "./handlers";
import { reportInterruptedReview } from "@/lib/github/pipeline/review-interrupted";
import { isRetryable } from "./errors";
import { claimNext, complete, extendLease, fail, failAbandoned, markProgress } from "./queue";
import type { Job } from "@/types";

const HEARTBEAT_MS = 30_000;

export type JobOutcome = "done" | "retry" | "failed" | "superseded";

/**
 * Claims one due job and runs it. Returns null when nothing is due.
 * `now` is for tests; the worker passes the real clock.
 */
export async function processNextJob(now?: Date): Promise<JobOutcome | null> {
  for (const dead of await failAbandoned(now)) {
    console.log(JSON.stringify({ msg: "job.abandoned", id: dead._id.toString(), kind: dead.kind, prKey: dead.prKey, attempt: dead.attempts }));
    await reportInterrupted(dead);
  }
  const job = await claimNext(now);
  if (!job) return null;
  return execute(job, now);
}

async function execute(job: Job, now?: Date): Promise<JobOutcome> {
  const started = Date.now();
  const log = (event: string, extra: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ msg: `job.${event}`, id: job._id.toString(), kind: job.kind, prKey: job.prKey, attempt: job.attempts, ...extra }));

  // A previous attempt got past a step that must not repeat (posted the
  // review or the answer) before dying: there is nothing safe left to do.
  if (!alreadyDone(job)) {
    const progress = { ...job.progress };
    const heartbeat = setInterval(() => void extendLease(job).catch(() => {}), HEARTBEAT_MS);
    try {
      log("start");
      await runJob(job, {
        isFinalAttempt: job.attempts >= job.maxAttempts,
        markProgress: async (patch) => {
          Object.assign(progress, patch);
          await markProgress(job, patch, now);
        },
      });
    } catch (err) {
      const retryable = isRetryable(err) && !alreadyDone({ ...job, progress });
      const outcome = await fail(job, err, { retryable }, now);
      log(outcome === "failed" ? "failed" : outcome, { ms: Date.now() - started, error: (err as Error)?.message });
      if (outcome === "failed") {
        console.error(`Job ${job._id} failed:`, err);
        await reportInterrupted({ ...job, progress });
      }
      return outcome;
    } finally {
      clearInterval(heartbeat);
    }
  }

  // The work is done; failing to record that mustn't turn it into a failure.
  // The job then stays "running" and its lease expiry re-checks it.
  try {
    await complete(job, now);
  } catch (err) {
    console.error(`Job ${job._id} finished but couldn't be marked done:`, err);
  }
  log("done", { ms: Date.now() - started, ...(alreadyDone(job) ? { skipped: "already_done" } : {}) });
  return "done";
}

/** Telling the PR is best effort: it must never take the worker down. */
async function reportInterrupted(job: Job): Promise<void> {
  try {
    await reportInterruptedReview(job);
  } catch (err) {
    console.error(`Couldn't report interrupted job ${job._id}:`, err);
  }
}
