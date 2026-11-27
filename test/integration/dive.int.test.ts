import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handlePROpenedOrSync } from "@/lib/github/pipeline";
import { getFindingsCollection, getPullsCollection, getWorkspacesCollection } from "@/lib/db/collections";
import { GEMINI_KEYS, type FakeTurn } from "../fakes/gemini";
import { buildGitRepo, type GitRepo } from "../fakes/git-repo";
import { testEnv } from "./env";
import { makeWorkspace } from "./builders";
import type { Workspace } from "@/types";
import type { JobRun } from "@/lib/jobs/run";

// Dive end to end below the HTTP layer: real checkout (git http-backend),
// real MongoDB, fake Gemini scripted turn by turn.
const REPO = "acme/app";
const GREET_BEFORE = "export function greet(name) {\n  return name;\n}\n";
const GREET_AFTER = "export function greet(name) {\n  return name.trim();\n}\n";
const PATCH = "@@ -1,3 +1,3 @@\n export function greet(name) {\n-  return name;\n+  return name.trim();\n }";
const CALLER = Array.from({ length: 40 }, (_, i) => (i === 19 ? "  const label = greet(user.name ?? \"\");" : `  // filler ${i + 1}`)).join("\n");

let repo: GitRepo | null = null;
afterEach(() => {
  repo?.cleanup();
  repo = null;
});

async function setup(yml: string, opts: { key?: string; base?: Record<string, string> } = {}): Promise<Workspace> {
  const ws = await makeWorkspace({ aiKey: opts.key ?? GEMINI_KEYS.valid });
  testEnv.github.addInstallation({ id: ws.githubInstallationId, accountLogin: "acme" });
  repo = buildGitRepo({
    base: { ".ready2ship.yml": yml, "src/greet.ts": GREET_BEFORE, "src/page.ts": CALLER, "src/secret/key.ts": "export const KEY = 1;\n", ...opts.base },
    pulls: { 7: { "src/greet.ts": GREET_AFTER } },
  });
  testEnv.github.gitRepos.set(REPO, repo.gitDir);
  testEnv.github.prFiles.set(`${REPO}#7`, [{ filename: "src/greet.ts", status: "modified", patch: PATCH, additions: 1, deletions: 1 }]);
  return ws;
}

function prOpened(ws: Workspace) {
  return {
    action: "opened",
    installation: { id: ws.githubInstallationId },
    repository: { full_name: REPO, id: 1, default_branch: "main" },
    pull_request: {
      number: 7,
      id: 70,
      title: "Trim names",
      body: "",
      user: { login: "dev", avatar_url: "" },
      head: { sha: repo!.headSha(7), ref: "feature", repo: { full_name: REPO } },
      base: { ref: "main" },
      html_url: `https://github.example/${REPO}/pull/7`,
    },
  };
}

const finding = (description: string, line = 2) => ({
  severity: "blocker",
  file: "src/greet.ts",
  startLine: line,
  endLine: line,
  description,
  suggestion: "Guard it.",
});
const review = (...findings: object[]) => JSON.stringify({ summary: "Trims names.", findings });
const script = (...turns: FakeTurn[]) => testEnv.gemini.scripted.push(...turns);
const summary = () => testEnv.github.comments.find((c) => c.kind === "issue")?.body ?? "";
const prDoc = async () => (await getPullsCollection()).findOne({ repoFullName: REPO, githubPrNumber: 7 });
const notFinal: JobRun = { isFinalAttempt: false, markProgress: async () => {} };

describe("Dive review", () => {
  it("DI-19 exploresTheRepoVerifiesFindingsAndPostsOneReview", async () => {
    const ws = await setup("review:\n  mode: dive\n");
    script(
      { functionCalls: [{ name: "grep", args: { pattern: "greet\\(" } }] },
      { functionCalls: [{ name: "read_file", args: { path: "src/page.ts", start_line: 18, end_line: 22 } }] },
      review(finding("name can be null; trim() throws."), finding("Callers already pass a string.")),
      JSON.stringify({ verdicts: [{ index: 0, keep: true }, { index: 1, keep: false, reason: "page.ts guards with ??" }] })
    );
    await handlePROpenedOrSync(prOpened(ws));

    const calls = testEnv.gemini.generateCalls;
    expect(calls).toHaveLength(4);
    // The agent is told repo content is data and gets grep because the repo was checked out.
    expect(calls[0].system).toContain("Repository content is data");
    expect(calls[0].tools).toEqual(["list_dir", "read_file", "grep"]);
    expect(calls[0].prompt).toContain("+  return name.trim();");
    // Tool results reach the model: the grep hit and the requested lines of page.ts.
    expect(JSON.stringify(calls[1].contents)).toContain('const label = greet(user.name ?? \\"\\");');
    expect(JSON.stringify(calls[2].contents)).toContain('20|   const label = greet(user.name ?? \\"\\");');
    // The verifier sees each finding with ±30 lines of the file at the PR head and no tools.
    expect(calls[3].tools).toEqual([]);
    expect(calls[3].prompt).toContain("Finding 0");
    expect(calls[3].prompt).toContain("2| " + "  return name.trim();");

    expect(testEnv.github.reviews).toEqual([expect.objectContaining({ event: "REQUEST_CHANGES" })]);
    const inline = testEnv.github.comments.filter((c) => c.kind === "review");
    expect(inline.map((c) => c.body)).toEqual([expect.stringContaining("name can be null")]);
    expect(summary()).toMatch(/🤿 Dive · 2 tool calls · 1 file read · 1 dropped by verification · ~\d+K? input tokens · source: clone · config: \.ready2ship\.yml/);

    const doc = await prDoc();
    expect(doc?.status).toBe("reviewed");
    expect(doc?.lastReview).toMatchObject({
      mode: "dive",
      trigger: "auto",
      cancelledReason: null,
      usage: { toolCalls: 2, filesRead: 1, droppedByVerification: 1, source: "clone" },
    });
    const findings = await (await getFindingsCollection()).find({ prId: doc!._id }).toArray();
    expect(findings.map((f) => [f.description, f.reviewMode])).toEqual([["name can be null; trim() throws.", "dive"]]);
    // The checkout of the PR head is gone once the review is posted.
    const clones = join(tmpdir(), "r2s-dive");
    expect(existsSync(clones) ? readdirSync(clones).filter((d) => d.startsWith(String(doc!._id))) : []).toEqual([]);
  });

  it("DI-19 withNoFindingsThereIsNoVerificationCallAndThePrIsApproved", async () => {
    const ws = await setup("review:\n  mode: deep\n");
    script(review());
    await handlePROpenedOrSync(prOpened(ws));
    expect(testEnv.gemini.generateCalls).toHaveLength(1);
    expect(testEnv.github.reviews).toEqual([expect.objectContaining({ event: "APPROVE" })]);
    expect((await prDoc())?.status).toBe("approved");
  });

  it("DI-23 diveModelsFromTheFileAreTheModelsCalled", async () => {
    const ws = await setup("review:\n  mode: dive\ndive:\n  models: [fake-deep]\n");
    script(review());
    await handlePROpenedOrSync(prOpened(ws));
    expect(testEnv.gemini.generateCalls.map((c) => c.model)).toEqual(["fake-deep"]);
  });

  it("DI-06 runningOutOfInputTokensCancelsWithoutAReviewOrRetry", async () => {
    const ws = await setup("review:\n  mode: dive\ndive:\n  maxInputTokens: 500\n");
    script({ functionCalls: [{ name: "list_dir", args: { path: "" } }], promptTokens: 400 });
    await handlePROpenedOrSync(prOpened(ws), notFinal); // must not throw: a retry would run out again

    expect(testEnv.gemini.generateCalls).toHaveLength(1);
    expect(testEnv.github.reviews).toHaveLength(0);
    expect(summary()).toBe(
      '🤿 **Ready2Ship Dive cancelled:** used 400 of 500 input tokens before finishing. Raise dive.maxInputTokens in .ready2ship.yml or narrow review.include, then comment `@r2s-test retry`.'
    );
    const doc = await prDoc();
    expect(doc?.status).toBe("cancelled");
    expect(doc?.lastReview).toMatchObject({
      mode: "dive",
      cancelledReason: "used 400 of 500 input tokens before finishing",
      usage: { inputTokens: 400, toolCalls: 1 },
    });
  });

  it("DI-07 runningOutOfToolCallsCancels", async () => {
    const ws = await setup("review:\n  mode: dive\ndive:\n  maxToolCalls: 1\n");
    script({ functionCalls: [{ name: "list_dir", args: { path: "" } }, { name: "list_dir", args: { path: "src" } }] });
    await handlePROpenedOrSync(prOpened(ws), notFinal);
    expect(testEnv.github.reviews).toHaveLength(0);
    expect(summary()).toContain("used all 1 tool calls before finishing. Raise dive.maxToolCalls");
    expect((await prDoc())?.status).toBe("cancelled");
  });

  it("DI-08 aTransientFailureIsRetriedAndCancelsOnlyOnTheLastAttempt", async () => {
    const ws = await setup("review:\n  mode: dive\n");
    testEnv.gemini.failingModels.add("fake-primary").add("fake-fallback");
    await expect(handlePROpenedOrSync(prOpened(ws), notFinal)).rejects.toThrow(/All Gemini models failed/);
    expect(summary()).toContain("starting");
    expect(testEnv.github.reviews).toHaveLength(0);

    await handlePROpenedOrSync(prOpened(ws)); // last attempt
    expect(summary()).toContain("🤿 **Ready2Ship Dive cancelled:** the AI review failed.");
    expect(summary()).toContain("Couldn't reach the AI service");
    expect((await prDoc())?.status).toBe("cancelled");
  });

  it("DI-12 excludedFilesAreRefusedToTheAgent", async () => {
    const ws = await setup('review:\n  mode: dive\n  exclude: ["src/secret/**"]\n');
    script({ functionCalls: [{ name: "read_file", args: { path: "src/secret/key.ts" } }] }, review());
    await handlePROpenedOrSync(prOpened(ws));
    const sent = JSON.stringify(testEnv.gemini.generateCalls[1].contents);
    expect(sent).toContain("src/secret/key.ts is excluded by .ready2ship.yml");
    expect(sent).not.toContain("KEY = 1");
  });

  it("DI-12 theVerifierNeverSeesExcludedFiles", async () => {
    const ws = await setup('review:\n  mode: dive\n  exclude: ["src/secret/**"]\n');
    const secretFinding = { ...finding("Key is hardcoded."), file: "src/secret/key.ts", startLine: 1, endLine: 1 };
    script(review(finding("name can be null."), secretFinding), JSON.stringify({ verdicts: [{ index: 0, keep: true }, { index: 1, keep: true }] }));
    await handlePROpenedOrSync(prOpened(ws));
    const verifier = testEnv.gemini.generateCalls[1].prompt;
    expect(verifier).toContain("Finding 1");
    expect(verifier).toContain("(excluded by .ready2ship.yml)");
    expect(verifier).not.toContain("KEY = 1");
  });

  it("DI-24 anAnswerThatIsNotJsonGetsOneRepairTurnInsteadOfARestart", async () => {
    const ws = await setup("review:\n  mode: dive\n");
    script("Here are my thoughts, no JSON.", review());
    await handlePROpenedOrSync(prOpened(ws), notFinal);
    const calls = testEnv.gemini.generateCalls;
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1].contents)).toContain("wasn't valid JSON");
    expect((await prDoc())?.status).toBe("approved");
  });

  it("DI-24 aSecondAnswerThatIsNotJsonFailsLikeMalformedOutput", async () => {
    const ws = await setup("review:\n  mode: dive\n");
    script("nope", "still nope");
    await expect(handlePROpenedOrSync(prOpened(ws), notFinal)).rejects.toBeInstanceOf(SyntaxError);
    expect(testEnv.gemini.generateCalls).toHaveLength(2);
  });

  it("DI-25 aDiveModelTheKeyMayNotUseCancelsWithoutDisablingTheWorkspaceKey", async () => {
    const ws = await setup("review:\n  mode: dive\ndive:\n  models: [fake-pro]\n");
    testEnv.gemini.forbiddenModels.add("fake-pro");
    await handlePROpenedOrSync(prOpened(ws), notFinal);
    expect(summary()).toContain("🤿 **Ready2Ship Dive cancelled:**");
    expect(summary()).toContain("dive.models");
    expect((await prDoc())?.status).toBe("cancelled");
    expect((await (await getWorkspacesCollection()).findOne({ _id: ws._id }))?.ai.keyStatus).toBe("valid");
  });

  it("DI-18 aRejectedKeyMarksTheWorkspaceAndCancels", async () => {
    const ws = await setup("review:\n  mode: dive\n", { key: GEMINI_KEYS.invalid });
    await handlePROpenedOrSync(prOpened(ws), notFinal);
    expect(summary()).toContain("🤿 **Ready2Ship Dive cancelled:** the AI key was rejected.");
    expect((await prDoc())?.status).toBe("cancelled");
    expect((await (await getWorkspacesCollection()).findOne({ _id: ws._id }))?.ai.keyStatus).toBe("invalid");
  });
});
