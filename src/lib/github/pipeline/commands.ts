import { getFindingsCollection, getPullsCollection } from "@/lib/db/collections";
import { addReactionToComment, getPRFiles } from "@/lib/github/api";
import { canCommandBot, isFixItCommand, looksLikeQuestion } from "@/lib/github/webhooks";
import { answerQuestion } from "@/lib/ai/answer";
import { buildDiffFromFiles } from "@/lib/ai/review";
import { config } from "@/lib/config";
import { activeWorkspace, answerOrMarkInvalid, isOwnComment, splitRepo } from "./shared";
import { applyFix, checkAndApprovePR } from "./fixes";
import { NO_JOB, type JobRun } from "@/lib/jobs/run";

/**
 * A comment on a PR, from either the conversation (issue_comment) or a review
 * thread (pull_request_review_comment). The two differ only in where the bot
 * replies, which `reply` captures.
 */
export interface CommandContext {
  installationId: number;
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  prBody: string | null;
  comment: {
    id: number;
    body: string;
    login: string;
    authorAssociation: string | undefined;
    inReplyToId: number | undefined;
  };
  reply: (message: string) => Promise<unknown>;
}

export async function handleCommand(ctx: CommandContext, run: JobRun = NO_JOB): Promise<void> {
  if (isOwnComment(ctx.comment.login)) return;
  if (!canCommandBot(ctx.comment.authorAssociation)) return;

  const workspace = await activeWorkspace(ctx.installationId);
  if (!workspace) return;

  const prDoc = await (await getPullsCollection()).findOne({
    workspaceId: workspace._id,
    repoFullName: ctx.repoFullName,
    githubPrNumber: ctx.prNumber,
  });
  if (!prDoc) return;

  const { owner, repo } = splitRepo(ctx.repoFullName);
  const { appSlug } = config().github;

  if (isFixItCommand(ctx.comment.body, appSlug)) {
    // "fix it" is a reply to the finding's inline comment.
    const replyToId = ctx.comment.inReplyToId;
    if (!replyToId) return;

    const findings = await getFindingsCollection();
    const finding = await findings.findOne({ prId: prDoc._id, githubCommentId: replyToId, status: "open" });
    if (!finding?.fix?.original) {
      await ctx.reply(`⚠️ No automatic fix for this comment. Apply the change manually.`);
      return;
    }

    const applied = await applyFix({
      installationId: ctx.installationId,
      owner,
      repo,
      head: { ref: prDoc.headBranch, repoFullName: prDoc.headRepoFullName },
      filePath: finding.file,
      original: finding.fix.original,
      replacement: finding.fix.replacement,
      description: finding.description,
      reply: ctx.reply,
    });
    if (!applied) return;

    await findings.updateOne({ _id: finding._id }, { $set: { status: "fixed" } });
    await checkAndApprovePR(ctx.installationId, owner, repo, ctx.prNumber, prDoc.headSha, prDoc._id);
    return;
  }

  if (looksLikeQuestion(ctx.comment.body, appSlug)) {
    // 👀 signals the bot is thinking; reactions may be unavailable.
    try {
      await addReactionToComment(ctx.installationId, owner, repo, ctx.comment.id, "eyes");
    } catch {
      // ignore
    }

    const files = await getPRFiles(ctx.installationId, owner, repo, ctx.prNumber);
    const diff = buildDiffFromFiles(files);
    const answer = await answerOrMarkInvalid(workspace, (provider) =>
      answerQuestion(provider, ctx.comment.body, ctx.prTitle, ctx.prBody ?? "", diff, prDoc.summary)
    );
    if (!answer) return;
    await ctx.reply(answer);
    await run.markProgress({ replied: true });
  }
}
