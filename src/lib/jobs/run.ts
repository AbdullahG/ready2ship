import type { Job } from "@/types";

/**
 * What a handler knows about the job it runs in. Handlers called outside the
 * queue (tests, synchronous paths) get NO_JOB: a single, final attempt.
 */
export interface JobRun {
  /** On the last attempt a handler reports failures on the PR instead of rethrowing. */
  isFinalAttempt: boolean;
  /** Records side effects that must not be repeated if the job is retried. */
  markProgress(patch: Job["progress"]): Promise<void>;
}

export const NO_JOB: JobRun = {
  isFinalAttempt: true,
  markProgress: async () => {},
};
