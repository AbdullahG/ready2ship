import { describe, expect, it, vi } from "vitest";

// complete() fails once (e.g. a MongoDB blip right after the work was done).
vi.mock("@/lib/jobs/queue", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/jobs/queue")>();
  return {
    ...real,
    complete: vi.fn().mockRejectedValueOnce(new Error("db blip")).mockImplementation(real.complete),
    fail: vi.fn(real.fail),
  };
});

import { processNextJob } from "@/lib/jobs/runner";
import { enqueue, fail } from "@/lib/jobs/queue";
import { getJobsCollection } from "@/lib/db/collections";

describe("runner", () => {
  it("Q-19 aFailureToRecordCompletionDoesNotTurnFinishedWorkIntoAFailure", async () => {
    // A "closed" job for an unknown installation is a no-op that succeeds.
    await enqueue({ deliveryId: "d", event: "pull_request", kind: "closed", prKey: "1:a/b#1", maxAttempts: 4, payload: { installation: { id: 1 }, repository: { full_name: "a/b" }, pull_request: { number: 1 } } });
    const outcome = await processNextJob();
    expect(outcome).toBe("done");
    expect(fail).not.toHaveBeenCalled();
    const [job] = await (await getJobsCollection()).find({}).toArray();
    // Left running; its lease expires and the (idempotent) work is redone at worst.
    expect(job.status).not.toBe("failed");
    expect(job.status).not.toBe("pending");
  });
});
