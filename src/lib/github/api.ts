import { Octokit } from "@octokit/rest";
import { getInstallationOctokit } from "./app";

interface PRFile {
  filename: string;
  status: string;
  patch?: string;
  additions: number;
  deletions: number;
}

export async function getPRFiles(
  installationId: number,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<PRFile[]> {
  const octokit = await getInstallationOctokit(installationId);
  const { data } = await octokit.pulls.listFiles({
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });
  return data as PRFile[];
}

/** Default branch and size (KB) of a repository. */
export async function getRepoInfo(
  installationId: number,
  owner: string,
  repo: string
): Promise<{ defaultBranch: string; sizeKb: number }> {
  const octokit = await getInstallationOctokit(installationId);
  const { data } = await octokit.repos.get({ owner, repo });
  return { defaultBranch: data.default_branch, sizeKb: data.size };
}

/** Every path in the commit's tree (recursive). */
export async function getRepoTree(
  installationId: number,
  owner: string,
  repo: string,
  sha: string
): Promise<Array<{ path: string; type: "blob" | "tree" }>> {
  const octokit = await getInstallationOctokit(installationId);
  const { data } = await octokit.git.getTree({ owner, repo, tree_sha: sha, recursive: "true" });
  return data.tree
    .filter((e): e is typeof e & { path: string } => !!e.path && (e.type === "blob" || e.type === "tree"))
    .map((e) => ({ path: e.path, type: e.type as "blob" | "tree" }));
}

/** A text file's content at `ref`, or null when it doesn't exist there. */
export async function getFileTextOrNull(
  installationId: number,
  owner: string,
  repo: string,
  path: string,
  ref: string
): Promise<string | null> {
  try {
    return (await getFileContent(installationId, owner, repo, path, ref)).content;
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
}

export async function createIssueComment(
  installationId: number,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string
): Promise<number> {
  const octokit = await getInstallationOctokit(installationId);
  const { data } = await octokit.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body,
  });
  return data.id;
}

export async function updateIssueComment(
  installationId: number,
  owner: string,
  repo: string,
  commentId: number,
  body: string
): Promise<void> {
  const octokit = await getInstallationOctokit(installationId);
  await octokit.issues.updateComment({
    owner,
    repo,
    comment_id: commentId,
    body,
  });
}

export interface ReviewCommentInput {
  path: string;
  line: number;
  body: string;
  start_line?: number;
}

export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

// Submits all inline comments + the review verdict as a single review,
// so the PR author gets one notification instead of one per finding.
// Returns posted comments aligned to the `comments` input order (id 0 = failed).
export async function submitReview(
  installationId: number,
  owner: string,
  repo: string,
  pullNumber: number,
  commitId: string,
  event: ReviewEvent,
  body: string,
  comments: ReviewCommentInput[]
): Promise<Array<{ id: number; body: string; path: string; line: number | null }>> {
  const octokit = await getInstallationOctokit(installationId);

  const ghComments = comments.map((c) => ({
    path: c.path,
    line: c.line,
    side: "RIGHT" as const,
    body: c.body,
    ...(c.start_line && c.start_line !== c.line
      ? { start_line: c.start_line, start_side: "RIGHT" as const }
      : {}),
  }));

  try {
    const { data: review } = await octokit.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      commit_id: commitId,
      event,
      body,
      comments: ghComments,
    });

    if (comments.length === 0) return [];

    // createReview doesn't return per-comment IDs; fetch them and match back.
    const posted = await octokit.paginate(octokit.pulls.listCommentsForReview, {
      owner,
      repo,
      pull_number: pullNumber,
      review_id: review.id,
      per_page: 100,
    });

    const pool = [...posted];
    return comments.map((c) => {
      const i = pool.findIndex(
        (p) => p.path === c.path && p.line === c.line && p.body === c.body
      );
      if (i === -1) return { id: 0, body: c.body, path: c.path, line: c.line };
      const [match] = pool.splice(i, 1);
      return { id: match.id, body: match.body, path: match.path, line: match.line ?? null };
    });
  } catch (err) {
    // Callers pre-validate comment lines against the diff, so this should be
    // rare. Posting comments one-by-one here would notify per comment, so
    // instead submit the verdict alone; findings still show in the summary.
    console.error("Batch review failed, posting verdict without inline comments:", err);

    try {
      await octokit.pulls.createReview({
        owner,
        repo,
        pull_number: pullNumber,
        commit_id: commitId,
        event,
        body,
      });
    } catch (reviewErr) {
      console.error("Review verdict post failed:", reviewErr);
    }

    return comments.map((c) => ({ id: 0, body: c.body, path: c.path, line: c.line }));
  }
}

export async function approvePR(
  installationId: number,
  owner: string,
  repo: string,
  pullNumber: number,
  commitId: string,
  body = ""
): Promise<void> {
  const octokit = await getInstallationOctokit(installationId);
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number: pullNumber,
    commit_id: commitId,
    event: "APPROVE",
    body,
  });
}

export async function replyToReviewComment(
  installationId: number,
  owner: string,
  repo: string,
  pullNumber: number,
  commentId: number,
  body: string
): Promise<void> {
  const octokit = await getInstallationOctokit(installationId);
  await octokit.pulls.createReplyForReviewComment({
    owner,
    repo,
    pull_number: pullNumber,
    comment_id: commentId,
    body,
  });
}

export async function getFileContent(
  installationId: number,
  owner: string,
  repo: string,
  path: string,
  ref: string
): Promise<{ content: string; sha: string }> {
  const octokit = await getInstallationOctokit(installationId);
  const { data } = await octokit.repos.getContent({
    owner,
    repo,
    path,
    ref,
  });

  if (Array.isArray(data) || data.type !== "file") {
    throw new Error(`${path} is not a file`);
  }

  const content = Buffer.from(data.content, "base64").toString("utf-8");
  return { content, sha: data.sha };
}

export async function commitFileChange(
  installationId: number,
  owner: string,
  repo: string,
  path: string,
  content: string,
  sha: string,
  branch: string,
  message: string
): Promise<void> {
  const octokit = await getInstallationOctokit(installationId);
  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path,
    message,
    content: Buffer.from(content, "utf-8").toString("base64"),
    sha,
    branch,
  });
}

export async function addReactionToComment(
  installationId: number,
  owner: string,
  repo: string,
  commentId: number,
  content: "+1" | "eyes" | "heart" | "rocket" | "hooray" | "laugh" | "confused" | "-1",
  /** A conversation comment, or a comment in a review thread. */
  on: "issue" | "review" = "issue"
): Promise<void> {
  const octokit = await getInstallationOctokit(installationId);
  if (on === "review") {
    await octokit.reactions.createForPullRequestReviewComment({ owner, repo, comment_id: commentId, content });
  } else {
    await octokit.reactions.createForIssueComment({ owner, repo, comment_id: commentId, content });
  }
}

/** The PR as it is now (head may have moved since the webhook). */
export async function getPullRequest(installationId: number, owner: string, repo: string, pullNumber: number) {
  const octokit = await getInstallationOctokit(installationId);
  const { data } = await octokit.pulls.get({ owner, repo, pull_number: pullNumber });
  return data;
}
