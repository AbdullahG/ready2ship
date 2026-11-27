import { ObjectId } from "mongodb";
import { getFindingsCollection, getPullsCollection } from "@/lib/db/collections";
import { approvePR, commitFileChange, getFileContent } from "@/lib/github/api";
import type { PRStatus } from "@/types";

/**
 * Applies a finding's suggested replacement to the PR branch and commits it.
 * Returns whether a commit was made; every outcome is reported via `reply`.
 */
export async function applyFix(input: {
  installationId: number;
  owner: string;
  repo: string;
  head: { ref: string; repoFullName: string | null };
  filePath: string;
  original: string;
  replacement: string;
  description: string;
  reply: (message: string) => Promise<unknown>;
}): Promise<boolean> {
  const { installationId, owner, repo, head, filePath, original, replacement, reply } = input;

  // The branch lives in the fork, not here: committing to a same-named branch
  // of the base repository would write to the wrong place (often main).
  if (head.repoFullName !== `${owner}/${repo}`) {
    await reply("⚠️ Fixes can't be applied to pull requests from forks. Apply the change in the fork.");
    return false;
  }

  const { content, sha } = await getFileContent(installationId, owner, repo, filePath, head.ref);

  // Normalize line endings for comparison
  const normalizedContent = content.replace(/\r\n/g, "\n");
  const normalizedOriginal = original.replace(/\r\n/g, "\n").trim();

  if (!normalizedContent.includes(normalizedOriginal)) {
    await reply(`⚠️ Fix not applied: the original code is no longer in this file. Already changed?`);
    return false;
  }

  // If replacement is empty (line deletion), also remove the now-empty line
  let updatedContent = normalizedContent.replace(normalizedOriginal, replacement);
  if (replacement === "") {
    updatedContent = updatedContent.replace(/\n[ \t]*\n(\n[ \t]*\n)+/g, "\n\n");
  }
  await commitFileChange(
    installationId,
    owner,
    repo,
    filePath,
    updatedContent,
    sha,
    head.ref,
    `fix: ${input.description.slice(0, 72)} [ready2ship]`
  );

  await reply(`✅ Fix applied and committed. \`${filePath}\` updated.`);
  return true;
}

/** Approves the PR once it has no open blockers. */
export async function checkAndApprovePR(
  installationId: number,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  prDocId: ObjectId
): Promise<void> {
  const openBlockers = await (await getFindingsCollection()).countDocuments({
    prId: prDocId,
    severity: "blocker",
    status: "open",
  });
  if (openBlockers > 0) return;

  try {
    await approvePR(installationId, owner, repo, prNumber, headSha, "✅ **Ready2Ship:** all blockers resolved. PR approved.");
    await (await getPullsCollection()).updateOne(
      { _id: prDocId },
      { $set: { status: "approved" as PRStatus, updatedAt: new Date() } }
    );
  } catch (err) {
    // PR might already be approved or closed
    console.error("Approve failed:", err);
  }
}
