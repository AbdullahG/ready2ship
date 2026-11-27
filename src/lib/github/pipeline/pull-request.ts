import { getPullsCollection, getFindingsCollection } from "@/lib/db/collections";
import { createIssueComment, updateIssueComment } from "@/lib/github/api";
import { getWorkspaceByInstallation } from "@/lib/workspaces/installations";
import type { PRStatus, PullRequest, Workspace } from "@/types";
import { activeWorkspace, splitRepo } from "./shared";
import { NO_JOB, type JobRun } from "@/lib/jobs/run";
import { STARTING_BODY } from "./format";
import { runReview } from "./review-run";

export interface PullRequestPayload {
  action: string;
  installation: { id: number };
  repository: { full_name: string; id: number; default_branch?: string };
  pull_request: PullRequestData;
}

export interface PullRequestData {
  number: number;
  id: number;
  title: string;
  body: string | null;
  user: { login: string; avatar_url: string };
  head: { sha: string; ref: string; repo?: { full_name: string } | null };
  base: { ref: string };
  html_url: string;
}

/**
 * Records the PR at its current head and puts the "starting" summary comment
 * up (one per PR, updated in place). Returns the PR document and a setter for
 * that comment.
 */
export async function preparePullRequest(
  workspace: Workspace,
  installationId: number,
  repoFullName: string,
  pr: PullRequestData,
  /** True when earlier open findings no longer apply (new commits, or a fresh review was asked for). */
  opts: { newCommits: boolean }
): Promise<{ prDoc: PullRequest; setSummary: (body: string) => Promise<void> }> {
  const { owner, repo } = splitRepo(repoFullName);
  const pulls = await getPullsCollection();
  const prFilter = { workspaceId: workspace._id, repoFullName, githubPrNumber: pr.number };

  const now = new Date();
  await pulls.updateOne(
    prFilter,
    {
      $set: {
        githubPrId: pr.id,
        headRepoFullName: pr.head.repo?.full_name ?? null,
        githubInstallationId: installationId,
        title: pr.title,
        author: pr.user.login,
        authorAvatarUrl: pr.user.avatar_url,
        headSha: pr.head.sha,
        headBranch: pr.head.ref,
        baseBranch: pr.base.ref,
        githubPrUrl: pr.html_url,
        status: "reviewing" as PRStatus,
        updatedAt: now,
      },
      $setOnInsert: {
        workspaceId: workspace._id,
        repoFullName,
        githubPrNumber: pr.number,
        summary: "",
        reviewStats: { blockers: 0, minors: 0, improvements: 0, resolvedBlockers: 0 },
        summaryCommentId: null,
        createdAt: now,
      },
    },
    { upsert: true }
  );

  const prDoc = await pulls.findOne(prFilter);
  if (!prDoc) throw new Error(`PR ${repoFullName}#${pr.number} vanished after upsert`);

  // New commits: the previous review's open findings no longer apply.
  if (opts.newCommits) {
    await (await getFindingsCollection()).deleteMany({ prId: prDoc._id, status: "open" });
  }

  let summaryCommentId = prDoc.summaryCommentId;
  if (!summaryCommentId) {
    summaryCommentId = await createIssueComment(installationId, owner, repo, pr.number, STARTING_BODY);
    await pulls.updateOne({ _id: prDoc._id }, { $set: { summaryCommentId } });
  } else {
    await updateIssueComment(installationId, owner, repo, summaryCommentId, STARTING_BODY);
  }
  const commentId = summaryCommentId;
  return {
    prDoc,
    setSummary: (body) => updateIssueComment(installationId, owner, repo, commentId, body),
  };
}

/** PR opened or new commits pushed: (re)review it in the repo's configured mode. */
export async function handlePROpenedOrSync(payload: PullRequestPayload, run: JobRun = NO_JOB): Promise<void> {
  const installationId = payload.installation.id;
  const repoFullName = payload.repository.full_name;

  const workspace = await activeWorkspace(installationId);
  if (!workspace) return;

  const { prDoc, setSummary } = await preparePullRequest(workspace, installationId, repoFullName, payload.pull_request, {
    newCommits: payload.action === "synchronize",
  });
  await runReview(
    {
      workspace,
      installationId,
      repoFullName,
      defaultBranch: payload.repository.default_branch,
      pr: payload.pull_request,
      prDoc,
      setSummary,
      trigger: "auto",
    },
    run
  );
}

export async function handlePRClosed(payload: {
  installation: { id: number };
  repository: { full_name: string };
  pull_request: { number: number };
}): Promise<void> {
  const workspace = await getWorkspaceByInstallation(payload.installation.id);
  if (!workspace) return;
  await (await getPullsCollection()).updateOne(
    { workspaceId: workspace._id, repoFullName: payload.repository.full_name, githubPrNumber: payload.pull_request.number },
    { $set: { status: "closed" as PRStatus, updatedAt: new Date() } }
  );
}
