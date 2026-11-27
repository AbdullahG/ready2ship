import { getFindingsCollection, getPullsCollection } from "@/lib/db/collections";
import { activeWorkspace, splitRepo } from "./shared";
import { checkAndApprovePR } from "./fixes";

/** A resolved review thread resolves its finding; the PR is approved once no blocker is open. */
export async function handleThreadResolved(payload: {
  installation: { id: number };
  repository: { full_name: string };
  pull_request: { number: number; head: { sha: string; ref: string } };
  thread: { comments: Array<{ id: number }> };
}): Promise<void> {
  const installationId = payload.installation.id;
  const repoFullName = payload.repository.full_name;
  const prNumber = payload.pull_request.number;

  const workspace = await activeWorkspace(installationId);
  if (!workspace) return;

  const prDoc = await (await getPullsCollection()).findOne({
    workspaceId: workspace._id,
    repoFullName,
    githubPrNumber: prNumber,
  });
  if (!prDoc) return;

  await (await getFindingsCollection()).updateMany(
    { prId: prDoc._id, githubCommentId: { $in: payload.thread.comments.map((c) => c.id) }, status: "open" },
    { $set: { status: "resolved" } }
  );

  const { owner, repo } = splitRepo(repoFullName);
  await checkAndApprovePR(installationId, owner, repo, prNumber, payload.pull_request.head.sha, prDoc._id);
}
