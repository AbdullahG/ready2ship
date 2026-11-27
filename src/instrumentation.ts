// Runs once when the server starts. Loading the config here makes a
// misconfigured deployment fail at boot with the list of missing variables
// instead of on the first request.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { config } = await import("@/lib/config");
  config();
  const { ensureIndexes } = await import("@/lib/db/collections");
  // Fail fast: without its indexes the job queue can't guarantee one running
  // job per pull request.
  await ensureIndexes();

  // Dive checkouts left in /tmp by a process that died mid-review.
  const { removeStaleCheckouts } = await import("@/lib/dive/source");
  await removeStaleCheckouts();

  // Webhook jobs run in this process (see src/lib/jobs). JOB_CONCURRENCY=0 turns it off.
  const { startConfiguredWorker, shutdownGracefully } = await import("@/lib/jobs/worker");
  const worker = startConfiguredWorker();

  // The Docker image sets NEXT_MANUAL_SIG_HANDLE so Next leaves signals to us:
  // drain running jobs, then exit. Without it Next exits immediately and cut
  // jobs are reclaimed after their lease.
  if (process.env.NEXT_MANUAL_SIG_HANDLE) {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.once(signal, () => void shutdownGracefully(signal, { worker }));
    }
  }
}
