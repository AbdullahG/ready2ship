import { config } from "@/lib/config";
import { processNextJob, type JobOutcome } from "./runner";

export interface Worker {
  /** Stops claiming jobs and resolves once the running ones finish. */
  stop(): Promise<void>;
  /** Ends any idle wait now, e.g. right after a job was queued in this process. */
  wake(): void;
}

declare global {
  var __r2sWorker: Worker | undefined;
}

/**
 * Runs `concurrency` loops in this process, each claiming and running one job
 * at a time and idling `pollMs` when the queue is empty.
 */
export function startWorker(opts: {
  concurrency: number;
  pollMs?: number;
  processNext?: () => Promise<JobOutcome | null>;
}): Worker {
  const pollMs = opts.pollMs ?? 1000;
  const processNext = opts.processNext ?? (() => processNextJob());
  let stopped = false;
  const sleepers = new Set<() => void>();
  // A wake-up while every loop is busy (e.g. mid-claim, just before a job was
  // queued) must not be lost, or the new job would wait a full poll.
  let wakePending = false;
  const wake = () => {
    if (sleepers.size === 0) wakePending = true;
    for (const resolve of sleepers) resolve();
    sleepers.clear();
  };
  const idle = () =>
    new Promise<void>((resolve) => {
      if (wakePending) {
        wakePending = false;
        resolve();
        return;
      }
      const done = () => {
        clearTimeout(timer);
        sleepers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, pollMs);
      sleepers.add(done);
    });

  const loop = async () => {
    while (!stopped) {
      try {
        if ((await processNext()) === null) await idle();
      } catch (err) {
        // e.g. MongoDB unreachable: keep the loop alive and try again later.
        console.error("Job worker error:", err);
        await idle();
      }
    }
  };
  const loops = Array.from({ length: opts.concurrency }, loop);

  const worker: Worker = {
    wake,
    async stop() {
      stopped = true;
      wake();
      await Promise.all(loops);
      if (globalThis.__r2sWorker === worker) globalThis.__r2sWorker = undefined;
    },
  };
  globalThis.__r2sWorker = worker;
  return worker;
}

/** Starts the configured worker once per process (dev hot reload calls this again). */
export function startConfiguredWorker(): Worker | null {
  if (globalThis.__r2sWorker) return globalThis.__r2sWorker;
  const { concurrency } = config().jobs;
  if (concurrency === 0) return null;
  const worker = startWorker({ concurrency });
  console.log(JSON.stringify({ msg: "job.worker_started", concurrency }));
  return worker;
}

/** Wakes this process's worker, if any; other instances pick the job up on their next poll. */
export function wakeWorker(): void {
  globalThis.__r2sWorker?.wake();
}

/**
 * SIGTERM/SIGINT handling when NEXT_MANUAL_SIG_HANDLE is set (Next would
 * otherwise exit at once): stop taking jobs, give running ones up to
 * `drainMs` to finish, then exit. Jobs cut short are reclaimed by the next
 * process once their lease expires.
 */
export async function shutdownGracefully(
  signal: "SIGTERM" | "SIGINT",
  opts: { worker: Worker | null; drainMs?: number; exit?: (code: number) => unknown }
): Promise<void> {
  const drainMs = opts.drainMs ?? 60_000;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  console.log(JSON.stringify({ msg: "job.worker_draining", signal, drainMs }));
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    opts.worker?.stop() ?? Promise.resolve(),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, drainMs);
    }),
  ]);
  clearTimeout(timer);
  await exit(signal === "SIGINT" ? 130 : 143);
}

export function workerStatus(): "running" | "disabled" {
  return globalThis.__r2sWorker ? "running" : "disabled";
}
