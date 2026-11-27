import { getPullsCollection } from "@/lib/db/collections";
import { updateIssueComment } from "@/lib/github/api";
import { config } from "@/lib/config";
import type { Job } from "@/types";
import { splitRepo } from "./shared";
import { interruptedBody } from "./format";

const REASON = "the review was interrupted before it finished";

/**
 * A review job that ran out of attempts without finishing (its worker died, or an
 * unexpected error): the PR's summary would otherwise say "starting..." forever.
 * Says so, with how to retry, unless the review was already posted.
 */
export async function reportInterruptedReview(job: Job): Promise<void> {
  if (job.kind !== "review" && job.kind !== "dive" && job.kind !== "retry") return;
  if (job.progress.reviewSubmitted) return;
  const m = /^(\d+):(.+)#(\d+)$/.exec(job.prKey ?? "");
  if (!m) return;
  const [, installationId, repoFullName, number] = m;

  const pulls = await getPullsCollection();
  const prDoc = await pulls.findOne({ githubInstallationId: Number(installationId), repoFullName, githubPrNumber: Number(number) });
  if (!prDoc?.summaryCommentId) return; // nothing was posted yet, so there is nothing stuck to correct

  const { owner, repo } = splitRepo(repoFullName);
  await updateIssueComment(Number(installationId), owner, repo, prDoc.summaryCommentId, interruptedBody(config().github.appSlug));
  await pulls.updateOne(
    { _id: prDoc._id },
    {
      $set: {
        status: "cancelled",
        lastReview: {
          mode: job.kind === "dive" ? "dive" : (prDoc.lastReview?.mode ?? "lookout"),
          trigger: job.kind === "dive" ? "comment" : (prDoc.lastReview?.trigger ?? "auto"),
          configSource: prDoc.lastReview?.configSource ?? "default",
          configWarnings: [],
          usage: null,
          cancelledReason: REASON,
          finishedAt: new Date(),
        },
        updatedAt: new Date(),
      },
    }
  );
}
