import { describe, expect, it } from "vitest";
import {
  handleIssueComment,
  handlePROpenedOrSync,
  handleReviewComment,
} from "@/lib/github/pipeline";
import {
  getFindingsCollection,
  getPullsCollection,
  getWorkspacesCollection,
} from "@/lib/db/collections";
import { GEMINI_KEYS } from "../fakes/gemini";
import { testEnv } from "./env";
import { makeWorkspace } from "./builders";
import type { Workspace } from "@/types";

const REPO = "acme/app";
const PATCH = "@@ -1,2 +1,3 @@\n export function greet(name) {\n-  return name;\n+  return name.trim();\n+}";

function prOpened(ws: Workspace, number = 7, action = "opened", headRepo = REPO) {
  return {
    action,
    installation: { id: ws.githubInstallationId },
    repository: { full_name: REPO, id: 1 },
    pull_request: {
      number,
      id: number * 10,
      title: "Add greet",
      body: "Adds a helper",
      user: { login: "dev", avatar_url: "" },
      head: { sha: "sha1", ref: "feature", repo: { full_name: headRepo } },
      base: { ref: "main" },
      html_url: `https://github.example/${REPO}/pull/${number}`,
    },
  };
}

function seedGitHub(ws: Workspace, number = 7) {
  testEnv.github.addInstallation({ id: ws.githubInstallationId, accountLogin: "acme" });
  testEnv.github.prFiles.set(`${REPO}#${number}`, [
    { filename: "src/greet.ts", status: "modified", patch: PATCH, additions: 2, deletions: 1 },
  ]);
}

function issueComment(ws: Workspace, body: string, association: string, login = "outsider") {
  return {
    action: "created",
    installation: { id: ws.githubInstallationId },
    repository: { full_name: REPO },
    issue: { number: 7, pull_request: { url: "x" }, title: "Add greet", body: "", user: { login: "dev" } },
    comment: { id: 555, body, user: { login }, author_association: association },
  };
}

function reviewReply(ws: Workspace, body: string, association: string, inReplyTo: number, login = "outsider") {
  return {
    action: "created",
    installation: { id: ws.githubInstallationId },
    repository: { full_name: REPO },
    pull_request: { number: 7, title: "Add greet", body: "", head: { sha: "sha1", ref: "feature" }, user: { login: "dev" } },
    comment: { id: 556, body, user: { login }, in_reply_to_id: inReplyTo, author_association: association },
  };
}

const summaryComments = () => testEnv.github.comments.filter((c) => c.kind === "issue");

describe("review pipeline with workspaces", () => {
  it("I-11 withoutAKeyPostsSetupInstructionsAndMarksNeedsSetupWithoutCallingAI", async () => {
    const ws = await makeWorkspace();
    seedGitHub(ws);

    await handlePROpenedOrSync(prOpened(ws));

    expect(testEnv.gemini.calls).toHaveLength(0);
    const [summary] = summaryComments();
    expect(summary.body).toContain("no AI key is configured");
    expect(summary.body).toContain(`http://r2s.test/w/${ws._id}/settings`);
    const pr = await (await getPullsCollection()).findOne({ githubPrNumber: 7 });
    expect(pr).toMatchObject({ status: "needs_setup" });
    expect(pr!.workspaceId.equals(ws._id)).toBe(true);
    expect(testEnv.github.reviews).toHaveLength(0);
  });

  it("I-11 aKeyAddedLaterReviewsOnTheNextPushReusingTheSameSummaryComment", async () => {
    const ws = await makeWorkspace();
    seedGitHub(ws);
    await handlePROpenedOrSync(prOpened(ws));

    const { encryptSecret } = await import("@/lib/crypto");
    await (await getWorkspacesCollection()).updateOne(
      { _id: ws._id },
      { $set: { "ai.encryptedKey": encryptSecret(GEMINI_KEYS.valid), "ai.keyStatus": "valid" } }
    );
    await handlePROpenedOrSync(prOpened(ws, 7, "synchronize"));

    expect(summaryComments()).toHaveLength(1);
    expect(summaryComments()[0].body).toContain("Review complete");
    expect((await (await getPullsCollection()).findOne({ githubPrNumber: 7 }))!.status).toBe("reviewed");
  });

  it("I-12 withAValidKeyPostsTheReviewAndStoresFindingsInTheWorkspace", async () => {
    const ws = await makeWorkspace({ aiKey: GEMINI_KEYS.valid });
    seedGitHub(ws);

    await handlePROpenedOrSync(prOpened(ws));

    expect(testEnv.gemini.generateCalls.map((c) => c.key)).toEqual([GEMINI_KEYS.valid]);
    expect(testEnv.github.reviews).toEqual([expect.objectContaining({ event: "REQUEST_CHANGES" })]);
    const findings = await (await getFindingsCollection()).find({}).toArray();
    expect(findings).toHaveLength(1);
    expect(findings[0].workspaceId.equals(ws._id)).toBe(true);
    expect(findings[0].githubCommentId).toBeGreaterThan(0);
    const after = await (await getWorkspacesCollection()).findOne({ _id: ws._id });
    expect(after!.firstReviewAt).toBeInstanceOf(Date);
  });

  it("I-12 firstReviewAtIsNotOverwrittenByLaterReviews", async () => {
    const first = new Date("2026-01-01T00:00:00Z");
    const ws = await makeWorkspace({ aiKey: GEMINI_KEYS.valid, firstReviewAt: first });
    seedGitHub(ws);
    await handlePROpenedOrSync(prOpened(ws));
    const after = await (await getWorkspacesCollection()).findOne({ _id: ws._id });
    expect(after!.firstReviewAt).toEqual(first);
  });

  it("I-13 aRejectedKeyMarksTheWorkspaceInvalidAndExplainsOnThePR", async () => {
    const ws = await makeWorkspace({ aiKey: GEMINI_KEYS.invalid });
    seedGitHub(ws);

    await handlePROpenedOrSync(prOpened(ws));

    expect(summaryComments()[0].body).toContain("AI key was rejected");
    const after = await (await getWorkspacesCollection()).findOne({ _id: ws._id });
    expect(after!.ai.keyStatus).toBe("invalid");
    expect(testEnv.github.reviews).toHaveLength(0);
  });

  it("I-13 exhaustedQuotaIsExplainedWithoutInvalidatingTheKey", async () => {
    const ws = await makeWorkspace({ aiKey: GEMINI_KEYS.quota });
    seedGitHub(ws);

    await handlePROpenedOrSync(prOpened(ws));

    expect(summaryComments()[0].body).toMatch(/quota/i);
    expect((await (await getWorkspacesCollection()).findOne({ _id: ws._id }))!.ai.keyStatus).toBe("valid");
  });

  it("I-04 suspendedOrUnknownInstallationsAreIgnored", async () => {
    const ws = await makeWorkspace({ aiKey: GEMINI_KEYS.valid, status: "suspended" });
    seedGitHub(ws);
    await handlePROpenedOrSync(prOpened(ws));
    await handlePROpenedOrSync({ ...prOpened(ws), installation: { id: 999_999 } });

    expect(testEnv.github.comments).toHaveLength(0);
    expect(testEnv.gemini.calls).toHaveLength(0);
    expect(await (await getPullsCollection()).countDocuments({})).toBe(0);
  });

  it("I-14 outsidersCannotTriggerFixItOrQuestions", async () => {
    const ws = await makeWorkspace({ aiKey: GEMINI_KEYS.valid });
    seedGitHub(ws);
    await handlePROpenedOrSync(prOpened(ws));
    const finding = (await (await getFindingsCollection()).findOne({}))!;
    testEnv.github.fileContents.set(`${REPO}:src/greet.ts@feature`, {
      content: "export function greet(name) {\n  return name.trim();\n}\n",
      sha: "f1",
    });
    const before = {
      comments: testEnv.github.comments.length,
      ai: testEnv.gemini.generateCalls.length,
    };

    await handleReviewComment(reviewReply(ws, "fix it", "NONE", finding.githubCommentId!));
    await handleReviewComment(reviewReply(ws, "why is this a blocker?", "CONTRIBUTOR", finding.githubCommentId!));
    await handleIssueComment(issueComment(ws, "@r2s-test what does this do?", "FIRST_TIME_CONTRIBUTOR"));

    expect(testEnv.github.commits).toHaveLength(0);
    expect(testEnv.gemini.generateCalls).toHaveLength(before.ai);
    expect(testEnv.github.comments).toHaveLength(before.comments);
    expect((await (await getFindingsCollection()).findOne({}))!.status).toBe("open");
  });

  it("I-14 aCollaboratorCanApplyFixIt", async () => {
    const ws = await makeWorkspace({ aiKey: GEMINI_KEYS.valid });
    seedGitHub(ws);
    await handlePROpenedOrSync(prOpened(ws));
    const finding = (await (await getFindingsCollection()).findOne({}))!;
    testEnv.github.fileContents.set(`${REPO}:src/greet.ts@feature`, {
      content: "export function greet(name) {\n  return name.trim();\n}\n",
      sha: "f1",
    });

    await handleReviewComment(reviewReply(ws, "fix it", "COLLABORATOR", finding.githubCommentId!, "maintainer"));

    expect(testEnv.github.commits).toEqual([
      expect.objectContaining({ path: "src/greet.ts", branch: "feature", content: expect.stringContaining("(name ?? '').trim()") }),
    ]);
    expect((await (await getFindingsCollection()).findOne({}))!.status).toBe("fixed");
  });

  it("I-18 fixItIsRefusedForPullRequestsFromForks", async () => {
    const ws = await makeWorkspace({ aiKey: GEMINI_KEYS.valid });
    seedGitHub(ws);
    await handlePROpenedOrSync(prOpened(ws, 7, "opened", "outsider/app-fork"));
    const finding = (await (await getFindingsCollection()).findOne({}))!;
    testEnv.github.fileContents.set(`${REPO}:src/greet.ts@feature`, { content: "return name.trim();", sha: "f1" });

    await handleReviewComment(reviewReply(ws, "fix it", "COLLABORATOR", finding.githubCommentId!, "maintainer"));

    // The fork's branch name must never be written to on the base repository.
    expect(testEnv.github.commits).toHaveLength(0);
    expect(testEnv.github.comments.at(-1)!.body).toMatch(/fork/i);
    expect((await (await getFindingsCollection()).findOne({}))!.status).toBe("open");
  });

  it("I-19 theSameRepoAndNumberInTwoWorkspacesStaySeparate", async () => {
    const a = await makeWorkspace({ aiKey: GEMINI_KEYS.valid });
    const b = await makeWorkspace({ aiKey: GEMINI_KEYS.valid });
    seedGitHub(a);
    seedGitHub(b);

    await handlePROpenedOrSync(prOpened(a));
    await handlePROpenedOrSync(prOpened(b));

    const rows = await (await getPullsCollection()).find({}).toArray();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.workspaceId.toString()).sort()).toEqual([a._id.toString(), b._id.toString()].sort());
    expect(rows.every((r) => r.summaryCommentId)).toBe(true);
    expect(rows[0].summaryCommentId).not.toBe(rows[1].summaryCommentId);
  });

  it("I-15 commandsInAReviewThreadAreAnsweredInThatThread", async () => {
    const ws = await makeWorkspace({ aiKey: GEMINI_KEYS.valid });
    seedGitHub(ws);
    await handlePROpenedOrSync(prOpened(ws));
    const finding = (await (await getFindingsCollection()).findOne({}))!;
    testEnv.github.fileContents.set(`${REPO}:src/greet.ts@feature`, { content: "return name.trim();", sha: "f1" });
    testEnv.gemini.scripted.push("Because name can be null.");

    await handleReviewComment(reviewReply(ws, "why a blocker?", "MEMBER", finding.githubCommentId!, "teammate"));
    await handleReviewComment(reviewReply(ws, "fix it", "MEMBER", finding.githubCommentId!, "teammate"));

    const replies = testEnv.github.http.requests.filter((r) => r.path.endsWith(`/comments/${finding.githubCommentId}/replies`));
    expect(replies.map((r) => (r.body as { body: string }).body)).toEqual([
      "Because name can be null.",
      "✅ Fix applied and committed. `src/greet.ts` updated.",
    ]);
  });

  it("I-15 aMemberQuestionIsAnsweredWithTheWorkspaceKey", async () => {
    const ws = await makeWorkspace({ aiKey: GEMINI_KEYS.valid });
    seedGitHub(ws);
    await handlePROpenedOrSync(prOpened(ws));
    testEnv.gemini.scripted.push("Because name can be null.");

    await handleIssueComment(issueComment(ws, "why is this a blocker?", "MEMBER", "teammate"));

    expect(testEnv.gemini.generateCalls.at(-1)!.key).toBe(GEMINI_KEYS.valid);
    expect(testEnv.github.comments.at(-1)!.body).toBe("Because name can be null.");
  });

  it("I-15 questionsAreIgnoredQuietlyWhenTheWorkspaceHasNoKey", async () => {
    const ws = await makeWorkspace();
    seedGitHub(ws);
    await handlePROpenedOrSync(prOpened(ws));
    const before = testEnv.github.comments.length;

    await handleIssueComment(issueComment(ws, "why?", "OWNER", "boss"));

    expect(testEnv.github.comments).toHaveLength(before);
    expect(testEnv.gemini.calls).toHaveLength(0);
  });
});
