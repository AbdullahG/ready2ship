import { createIssueComment, replyToReviewComment } from "@/lib/github/api";
import { handleCommand } from "./commands";
import { splitRepo } from "./shared";
import { NO_JOB, type JobRun } from "@/lib/jobs/run";

interface CommentPayload {
  id: number;
  body: string;
  user: { login: string };
  in_reply_to_id?: number;
  author_association?: string;
}

/** A comment in the PR conversation. The bot answers in the conversation. */
export async function handleIssueComment(payload: {
  action: string;
  installation: { id: number };
  repository: { full_name: string };
  issue: { number: number; pull_request?: { url: string }; title: string; body: string | null; user?: { login: string } };
  comment: CommentPayload;
}, run: JobRun = NO_JOB): Promise<void> {
  if (!payload.issue.pull_request) return; // plain issues aren't PRs
  const { owner, repo } = splitRepo(payload.repository.full_name);
  const installationId = payload.installation.id;
  const prNumber = payload.issue.number;

  await handleCommand({
    installationId,
    repoFullName: payload.repository.full_name,
    prNumber,
    prTitle: payload.issue.title,
    prBody: payload.issue.body,
    comment: toComment(payload.comment),
    reply: (message) => createIssueComment(installationId, owner, repo, prNumber, message),
  }, run);
}

/** A comment in a review thread. The bot answers in the same thread. */
export async function handleReviewComment(payload: {
  action: string;
  installation: { id: number };
  repository: { full_name: string };
  pull_request: { number: number; title: string; body: string | null; head: { sha: string; ref: string }; user?: { login: string } };
  comment: CommentPayload & { pull_request_review_id?: number };
}, run: JobRun = NO_JOB): Promise<void> {
  const { owner, repo } = splitRepo(payload.repository.full_name);
  const installationId = payload.installation.id;
  const prNumber = payload.pull_request.number;
  const threadRootId = payload.comment.in_reply_to_id ?? payload.comment.id;

  await handleCommand({
    installationId,
    repoFullName: payload.repository.full_name,
    prNumber,
    prTitle: payload.pull_request.title,
    prBody: payload.pull_request.body,
    comment: toComment(payload.comment),
    reply: (message) => replyToReviewComment(installationId, owner, repo, prNumber, threadRootId, message),
  }, run);
}

function toComment(c: CommentPayload) {
  return {
    id: c.id,
    body: c.body,
    login: c.user.login,
    authorAssociation: c.author_association,
    inReplyToId: c.in_reply_to_id,
  };
}
