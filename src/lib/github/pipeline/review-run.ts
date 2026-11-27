// One review of one PR head, in Lookout or Dive mode: reads .ready2ship.yml,
// runs the review, and posts the result. Called for PR events and for the
// "@app dive" comment command.
import { ObjectId } from "mongodb";
import { getFindingsCollection, getPullsCollection, getWorkspacesCollection } from "@/lib/db/collections";
import { getFileTextOrNull, getPRFiles, getRepoInfo, submitReview } from "@/lib/github/api";
import { buildDiffFromFiles, isAlwaysSkipped, reviewPRDiff } from "@/lib/ai/review";
import { getProviderForWorkspace, type AIProvider } from "@/lib/ai";
import { InvalidKeyError, MissingKeyError } from "@/lib/ai/errors";
import { config } from "@/lib/config";
import { REPO_CONFIG_PATH, makePathFilter, parseRepoConfig, type RepoConfig, type RepoConfigResult, type ReviewMode } from "@/lib/repo-config";
import { runDive } from "@/lib/dive/agent";
import { DiveCancelledError } from "@/lib/dive/budget";
import { createRepoSource } from "@/lib/dive/source";
import type { FindingSeverity, LastReview, PRStatus, PullRequest, ReviewResult, ReviewUsage, Workspace } from "@/types";
import { markKeyInvalid, splitRepo } from "./shared";
import { isRetryable } from "@/lib/jobs/errors";
import type { JobRun } from "@/lib/jobs/run";
import type { PullRequestData } from "./pull-request";
import {
  configInvalidBody,
  diveCancelledBody,
  getCommentableLines,
  inlineCommentBody,
  noKeyBody,
  reviewFailedBody,
  reviewFooter,
  reviewStats,
  reviewVerdictBody,
  summaryBody,
} from "./format";

export interface ReviewTarget {
  workspace: Workspace;
  installationId: number;
  repoFullName: string;
  /** From the webhook payload when present; otherwise looked up. */
  defaultBranch?: string;
  pr: PullRequestData;
  prDoc: PullRequest;
  setSummary: (body: string) => Promise<void>;
  trigger: "auto" | "comment";
  /** The comment command forces Dive; otherwise .ready2ship.yml decides. */
  forceMode?: ReviewMode;
}

/** .ready2ship.yml from the repository's default branch; never from the PR's own branch. */
export async function loadRepoConfig(
  installationId: number,
  repoFullName: string,
  defaultBranch?: string
): Promise<RepoConfigResult> {
  const { owner, repo } = splitRepo(repoFullName);
  const branch = defaultBranch ?? (await getRepoInfo(installationId, owner, repo)).defaultBranch;
  return parseRepoConfig(await getFileTextOrNull(installationId, owner, repo, REPO_CONFIG_PATH, branch));
}

async function finish(prDoc: PullRequest, status: PRStatus, lastReview: Omit<LastReview, "finishedAt">): Promise<void> {
  await (await getPullsCollection()).updateOne(
    { _id: prDoc._id },
    { $set: { status, lastReview: { ...lastReview, finishedAt: new Date() }, updatedAt: new Date() } }
  );
}

export async function runReview(t: ReviewTarget, run: JobRun): Promise<void> {
  const { workspace, installationId, repoFullName, pr, prDoc, setSummary, trigger } = t;
  const { owner, repo } = splitRepo(repoFullName);
  const { appSlug } = config().github;
  const settingsUrl = `${config().baseUrl}/w/${workspace._id}/settings`;

  const loaded = await loadRepoConfig(installationId, repoFullName, t.defaultBranch);
  if (!loaded.ok) {
    await setSummary(configInvalidBody(loaded.error, appSlug));
    await finish(prDoc, "cancelled", {
      mode: t.forceMode ?? "lookout",
      trigger,
      configSource: "file",
      configWarnings: [],
      usage: null,
      cancelledReason: `.ready2ship.yml is invalid: ${loaded.error}`,
    });
    return;
  }
  const repoConfig = loaded.config;
  const mode = t.forceMode ?? repoConfig.mode;
  const record = (usage: ReviewUsage | null, cancelledReason: string | null): Omit<LastReview, "finishedAt"> => ({
    mode,
    trigger,
    configSource: repoConfig.source,
    configWarnings: repoConfig.warnings,
    usage,
    cancelledReason,
  });

  let provider: AIProvider;
  try {
    provider = getProviderForWorkspace(workspace, mode === "dive" ? { models: repoConfig.dive.models } : {});
  } catch (err) {
    if (!(err instanceof MissingKeyError)) throw err;
    await setSummary(noKeyBody(settingsUrl, appSlug));
    await finish(prDoc, "needs_setup", record(null, null));
    return;
  }

  const files = await getPRFiles(installationId, owner, repo, pr.number);
  const inScope = makePathFilter(repoConfig);
  const skippedByConfig = files.filter((f) => f.patch && !isAlwaysSkipped(f.filename) && !inScope(f.filename)).length;
  const diff = buildDiffFromFiles(files, inScope);

  let result: ReviewResult;
  let usage: ReviewUsage;
  try {
    ({ result, usage } =
      mode === "dive"
        ? await diveReview(t, provider, repoConfig, inScope, diff)
        : await reviewPRDiff(provider, pr.title, pr.body ?? "", diff || "(empty diff)"));
  } catch (err) {
    if (err instanceof DiveCancelledError) {
      console.log(JSON.stringify({ msg: "dive.cancelled", pr: `${repoFullName}#${pr.number}`, reason: err.reason, usage: err.usage }));
      await setSummary(diveCancelledBody(err.reason, err.hint, appSlug));
      await finish(prDoc, "cancelled", record(err.usage, err.reason));
      return;
    }
    console.error("AI review failed:", err);
    // Transient: leave the "starting" comment as is and let the queue retry.
    // A model chosen in .ready2ship.yml that the key may not use is that repo's problem, not a dead key:
    // marking the key invalid would stop reviews in every repo of the workspace.
    const repoModelRefused = err instanceof InvalidKeyError && mode === "dive" && repoConfig.dive.models.length > 0;
    if (repoModelRefused) {
      const reason = `the key was refused for dive.models (${repoConfig.dive.models.join(", ")}): ${err.message}`;
      await setSummary(diveCancelledBody(reason, "Check dive.models in .ready2ship.yml", appSlug));
      await finish(prDoc, "cancelled", record(null, reason));
      return;
    }
    if (isRetryable(err) && !run.isFinalAttempt) throw err;
    if (err instanceof InvalidKeyError) await markKeyInvalid(workspace);
    await setSummary(reviewFailedBody(err, settingsUrl, appSlug, mode));
    // Dive doesn't fall back to Lookout: a failed Dive is cancelled with its reason.
    if (mode === "dive") await finish(prDoc, "cancelled", record(null, (err as Error).message));
    else await finish(prDoc, "reviewed", record(null, null));
    return;
  }

  const footer = reviewFooter({
    mode,
    trigger,
    usage,
    configSource: repoConfig.source,
    warnings: repoConfig.warnings,
    skippedByConfig,
  });
  await postReview(t, mode, files, result, footer, run);
  await finish(prDoc, reviewStats(result.findings).blockers === 0 ? "approved" : "reviewed", record(usage, null));
}

/** Checks out the PR head (or falls back to the API) and runs the agent; the checkout is always removed. */
async function diveReview(
  t: ReviewTarget,
  provider: AIProvider,
  repoConfig: RepoConfig,
  inScope: (path: string) => boolean,
  diff: string
): Promise<{ result: ReviewResult; usage: ReviewUsage }> {
  const started = Date.now();
  const source = await createRepoSource({
    installationId: t.installationId,
    repoFullName: t.repoFullName,
    prNumber: t.pr.number,
    headSha: t.pr.head.sha,
    jobId: `${t.prDoc._id}-${started}`,
  });
  console.log(JSON.stringify({ msg: "dive.start", pr: `${t.repoFullName}#${t.pr.number}`, trigger: t.trigger, source: source.kind, limits: repoConfig.dive }));
  try {
    const out = await runDive({ provider, source, limits: repoConfig.dive, inScope, prTitle: t.pr.title, prBody: t.pr.body ?? "", diff });
    console.log(JSON.stringify({ msg: "dive.done", pr: `${t.repoFullName}#${t.pr.number}`, ms: Date.now() - started, usage: out.usage }));
    return out;
  } finally {
    await source.dispose();
  }
}

/** One GitHub review (inline comments + verdict), the findings, and the summary comment. */
async function postReview(
  t: ReviewTarget,
  mode: ReviewMode,
  files: Array<{ filename: string; patch?: string }>,
  result: ReviewResult,
  footer: string,
  run: JobRun
): Promise<void> {
  const { workspace, installationId, repoFullName, pr, prDoc, setSummary } = t;
  const { owner, repo } = splitRepo(repoFullName);

  // GitHub rejects the whole batched review (422) if any comment targets a
  // line outside the diff, so only findings on commentable lines get inline
  // comments; the rest still appear in the summary.
  const commentableLines = getCommentableLines(files);
  // findingIdx maps back to result.findings, since not every finding gets an inline comment.
  const inline: Array<{ findingIdx: number; path: string; line: number; body: string }> = [];
  result.findings.forEach((finding, findingIdx) => {
    if (!finding.file || !finding.endLine) return;
    if (!commentableLines.get(finding.file)?.has(finding.endLine)) {
      console.warn(`Finding line not in diff, skipping inline comment: ${finding.file}:${finding.endLine}`);
      return;
    }
    inline.push({ findingIdx, path: finding.file, line: finding.endLine, body: inlineCommentBody(finding) });
  });

  const stats = reviewStats(result.findings);

  // Single review = single notification: all inline comments + verdict together.
  const posted = await submitReview(
    installationId,
    owner,
    repo,
    pr.number,
    pr.head.sha,
    stats.blockers === 0 ? "APPROVE" : "REQUEST_CHANGES",
    reviewVerdictBody(stats, result.findings.length),
    inline.map(({ path, line, body }) => ({ path, line, body }))
  );
  // From here on, retrying would post the review a second time.
  await run.markProgress({ reviewSubmitted: true });
  const commentIdByFindingIdx = new Map<number, number>();
  inline.forEach((c, i) => {
    if (posted[i]?.id) commentIdByFindingIdx.set(c.findingIdx, posted[i].id);
  });

  const findingDocs = result.findings.map((finding, idx) => ({
    _id: new ObjectId(),
    workspaceId: workspace._id,
    prId: prDoc._id,
    severity: finding.severity as FindingSeverity,
    file: finding.file,
    startLine: finding.startLine,
    endLine: finding.endLine,
    description: finding.description,
    suggestion: finding.suggestion,
    fix: finding.fix,
    githubCommentId: commentIdByFindingIdx.get(idx) ?? null,
    status: "open" as const,
    reviewMode: mode,
    createdAt: new Date(),
  }));
  if (findingDocs.length > 0) await (await getFindingsCollection()).insertMany(findingDocs);

  await setSummary(`${summaryBody(result, stats)}\n\n${footer}`);
  await (await getPullsCollection()).updateOne(
    { _id: prDoc._id },
    { $set: { summary: result.summary, reviewStats: stats, updatedAt: new Date() } }
  );
  await (await getWorkspacesCollection()).updateOne(
    { _id: workspace._id, firstReviewAt: null },
    { $set: { firstReviewAt: new Date() } }
  );
}
