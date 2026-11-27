import { config } from "@/lib/config";
import { isDiveCommand, isFixItCommand, isRetryCommand, looksLikeQuestion } from "@/lib/github/webhooks";
import { handleReviewCommand } from "@/lib/github/pipeline/review-command";
import {
  handleIssueComment,
  handlePRClosed,
  handlePROpenedOrSync,
  handleReviewComment,
  handleThreadResolved,
} from "@/lib/github/pipeline";
import { enqueue, type EnqueueInput } from "./queue";
import type { JobRun } from "./run";
import type { Job } from "@/types";

type Payload = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// A review is retried once on a temporary failure; past that, its summary says how to ask again ("@app retry").
const MAX_ATTEMPTS = { review: 2, dive: 2, retry: 2, question: 2, fixIt: 1, thread: 4, closed: 4 } as const;

const prKey = (p: Payload, number: number) => `${p.installation?.id}:${p.repository?.full_name}#${number}`;

/** Which webhook deliveries become jobs, and how they're retried. Null = nothing to do. */
export function routeEvent(event: string, p: Payload): Omit<EnqueueInput, "deliveryId" | "event" | "payload"> | null {
  switch (event) {
    case "pull_request":
      if (p.action === "opened" || p.action === "synchronize") {
        return { kind: "review", prKey: prKey(p, p.pull_request.number), maxAttempts: MAX_ATTEMPTS.review };
      }
      if (p.action === "closed") {
        return { kind: "closed", prKey: prKey(p, p.pull_request.number), maxAttempts: MAX_ATTEMPTS.closed };
      }
      return null;
    case "issue_comment":
    case "pull_request_review_comment": {
      if (p.action !== "created") return null;
      if (event === "issue_comment" && !p.issue?.pull_request) return null;
      const { appSlug } = config().github;
      const login: string = p.comment?.user?.login ?? "";
      if (login === appSlug || login === `${appSlug}[bot]`) return null;
      const body: string = p.comment?.body ?? "";
      const number = event === "issue_comment" ? p.issue.number : p.pull_request.number;
      // A commit must never be made twice; a question may be asked again once.
      if (isFixItCommand(body, appSlug)) return { kind: "comment", prKey: prKey(p, number), maxAttempts: MAX_ATTEMPTS.fixIt };
      // Its own kind so a later push doesn't supersede it (only "review" jobs are).
      if (isDiveCommand(body, appSlug)) return { kind: "dive", prKey: prKey(p, number), maxAttempts: MAX_ATTEMPTS.dive };
      if (isRetryCommand(body, appSlug)) return { kind: "retry", prKey: prKey(p, number), maxAttempts: MAX_ATTEMPTS.retry };
      if (looksLikeQuestion(body, appSlug)) return { kind: "comment", prKey: prKey(p, number), maxAttempts: MAX_ATTEMPTS.question };
      return null;
    }
    case "pull_request_review_thread":
      if (p.action !== "resolved") return null;
      return { kind: "thread", prKey: prKey(p, p.pull_request.number), maxAttempts: MAX_ATTEMPTS.thread };
    default:
      return null;
  }
}

export async function enqueueWebhook(
  event: string,
  payload: unknown,
  deliveryId: string | null,
  now = new Date()
): Promise<{ queued: boolean }> {
  const route = routeEvent(event, payload as Payload);
  if (!route) return { queued: false };
  return enqueue({ ...route, deliveryId, event, payload }, now);
}

/** Side effects already done by an earlier attempt that must not be repeated. */
export function alreadyDone(job: Job): boolean {
  return !!(job.progress.reviewSubmitted || job.progress.replied);
}

export async function runJob(job: Job, run: JobRun): Promise<void> {
  const p = job.payload as Payload;
  switch (job.event) {
    case "pull_request":
      if (job.kind === "closed") return handlePRClosed(p as Parameters<typeof handlePRClosed>[0]);
      return handlePROpenedOrSync(p as Parameters<typeof handlePROpenedOrSync>[0], run);
    case "issue_comment":
    case "pull_request_review_comment":
      if (job.kind === "dive" || job.kind === "retry") {
        return handleReviewCommand(job.event, p as Parameters<typeof handleReviewCommand>[1], job.kind, run);
      }
      return job.event === "issue_comment"
        ? handleIssueComment(p as Parameters<typeof handleIssueComment>[0], run)
        : handleReviewComment(p as Parameters<typeof handleReviewComment>[0], run);
    case "pull_request_review_thread":
      return handleThreadResolved(p as Parameters<typeof handleThreadResolved>[0]);
    default:
      throw new Error(`No handler for job event ${job.event}`);
  }
}
