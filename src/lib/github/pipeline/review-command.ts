import { addReactionToComment, getPullRequest } from "@/lib/github/api";
import { canCommandBot } from "@/lib/github/webhooks";
import { getPullsCollection } from "@/lib/db/collections";
import { NO_JOB, type JobRun } from "@/lib/jobs/run";
import { activeWorkspace, isOwnComment, splitRepo } from "./shared";
import { preparePullRequest } from "./pull-request";
import { runReview, type ReviewTarget } from "./review-run";

export type ReviewCommand = "dive" | "retry";

/**
 * A review asked for in a PR comment (conversation or review thread), of the PR's current head:
 * "@app dive" runs a one-off Dive; "@app retry" runs the last review again, as a Dive if
 * that one was asked for with "@app dive", otherwise as .ready2ship.yml says.
 */
export async function handleReviewCommand(
  event: string,
  payload: {
    installation: { id: number };
    repository: { full_name: string; default_branch?: string };
    issue?: { number: number };
    pull_request?: { number: number };
    comment: { id: number; user: { login: string }; author_association?: string };
  },
  command: ReviewCommand,
  run: JobRun = NO_JOB
): Promise<void> {
  // A review spends the workspace's AI credits: only people with write access may ask.
  if (isOwnComment(payload.comment.user.login) || !canCommandBot(payload.comment.author_association)) return;

  const installationId = payload.installation.id;
  const workspace = await activeWorkspace(installationId);
  if (!workspace) return;

  const repoFullName = payload.repository.full_name;
  const { owner, repo } = splitRepo(repoFullName);
  const prNumber = payload.issue?.number ?? payload.pull_request?.number;
  if (!prNumber) return;

  // 👀 acknowledges the request; reactions may be unavailable.
  try {
    await addReactionToComment(installationId, owner, repo, payload.comment.id, "eyes", event === "issue_comment" ? "issue" : "review");
  } catch {
    // ignore
  }

  // Only "@app dive" records a "comment" trigger, so a retry of it is a Dive again.
  let target: Pick<ReviewTarget, "trigger" | "forceMode"> = { trigger: "comment", forceMode: "dive" };
  if (command === "retry") {
    const previous = await (await getPullsCollection()).findOne({ workspaceId: workspace._id, repoFullName, githubPrNumber: prNumber });
    if (previous?.lastReview?.trigger !== "comment") target = { trigger: "auto" };
  }

  const pr = await getPullRequest(installationId, owner, repo, prNumber);
  const prData = {
    number: pr.number,
    id: pr.id,
    title: pr.title,
    body: pr.body ?? null,
    user: { login: pr.user?.login ?? "", avatar_url: pr.user?.avatar_url ?? "" },
    head: { sha: pr.head.sha, ref: pr.head.ref, repo: pr.head.repo ? { full_name: pr.head.repo.full_name } : null },
    base: { ref: pr.base.ref },
    html_url: pr.html_url,
  };
  const { prDoc, setSummary } = await preparePullRequest(workspace, installationId, repoFullName, prData, { newCommits: true });
  await runReview(
    {
      workspace,
      installationId,
      repoFullName,
      defaultBranch: payload.repository.default_branch,
      pr: prData,
      prDoc,
      setSummary,
      ...target,
    },
    run
  );
}
