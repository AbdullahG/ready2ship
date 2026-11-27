import { describe, expect, it } from "vitest";
import { handlePROpenedOrSync } from "@/lib/github/pipeline";
import { getFindingsCollection, getPullsCollection } from "@/lib/db/collections";
import { GEMINI_KEYS } from "../fakes/gemini";
import { testEnv } from "./env";
import { makeWorkspace } from "./builders";
import type { Workspace } from "@/types";

// .ready2ship.yml lives in the reviewed repository; these tests check where
// it is read from and what each kind of file does to a review.
const REPO = "acme/app";
const PATCH = "@@ -1,2 +1,3 @@\n export function greet(name) {\n-  return name;\n+  return name.trim();\n+}";

function prOpened(ws: Workspace, number = 7) {
  return {
    action: "opened",
    installation: { id: ws.githubInstallationId },
    repository: { full_name: REPO, id: 1 },
    pull_request: {
      number,
      id: number * 10,
      title: "Add greet",
      body: "",
      user: { login: "dev", avatar_url: "" },
      head: { sha: "sha1", ref: "feature", repo: { full_name: REPO } },
      base: { ref: "main" },
      html_url: `https://github.example/${REPO}/pull/${number}`,
    },
  };
}

async function setup() {
  const ws = await makeWorkspace({ aiKey: GEMINI_KEYS.valid });
  testEnv.github.addInstallation({ id: ws.githubInstallationId, accountLogin: "acme" });
  testEnv.github.prFiles.set(`${REPO}#7`, [
    { filename: "src/greet.ts", status: "modified", patch: PATCH, additions: 2, deletions: 1 },
    { filename: "src/legacy/old.ts", status: "modified", patch: "@@ -1,1 +1,1 @@\n-a\n+b", additions: 1, deletions: 1 },
  ]);
  return ws;
}

const summary = () => testEnv.github.comments.find((c) => c.kind === "issue")?.body ?? "";
const pr = async () => (await getPullsCollection()).findOne({ repoFullName: REPO, githubPrNumber: 7 });

describe(".ready2ship.yml", () => {
  it("DI-01 withoutAFileTheReviewIsLookoutWithDefaults", async () => {
    const ws = await setup();
    await handlePROpenedOrSync(prOpened(ws));

    expect(testEnv.gemini.generateCalls).toHaveLength(1);
    expect(summary()).toContain("Review complete");
    expect(summary()).toMatch(/🔭 Lookout · .*config: default/);
    expect(testEnv.github.reviews).toHaveLength(1);
    const doc = await pr();
    expect(doc?.lastReview).toMatchObject({ mode: "lookout", trigger: "auto", configSource: "default", cancelledReason: null });
    expect(doc?.lastReview?.usage?.inputTokens).toBeGreaterThan(0);
    const findings = await (await getFindingsCollection()).find({ prId: doc!._id }).toArray();
    expect(findings.map((f) => f.reviewMode)).toEqual(["lookout"]);
  });

  it("DI-02 theFileIsReadFromTheDefaultBranch", async () => {
    const ws = await setup();
    testEnv.github.repos.set(REPO, { defaultBranch: "trunk", sizeKb: 100 });
    testEnv.github.putFile(REPO, ".ready2ship.yml", "trunk", "review:\n  mode: quick\n  speed: fast\n");
    await handlePROpenedOrSync(prOpened(ws));

    expect(summary()).toMatch(/🔭 Lookout · .*config: \.ready2ship\.yml/);
    expect(summary()).toContain("⚠️ .ready2ship.yml: unknown key review.speed");
    expect((await pr())?.lastReview).toMatchObject({ configSource: "file", configWarnings: ["unknown key review.speed"] });
  });

  it("DI-03 aFileOnlyOnThePullRequestBranchIsIgnored", async () => {
    const ws = await setup();
    testEnv.github.putFile(REPO, ".ready2ship.yml", "feature", "review:\n  mode: dive\n");
    testEnv.github.putFile(REPO, ".ready2ship.yml", "sha1", "review:\n  mode: dive\n");
    await handlePROpenedOrSync(prOpened(ws));

    expect((await pr())?.lastReview).toMatchObject({ mode: "lookout", configSource: "default" });
  });

  it("DI-04 excludeNarrowsTheDiffSentToTheModel", async () => {
    const ws = await setup();
    testEnv.github.putFile(REPO, ".ready2ship.yml", "main", 'review:\n  exclude: ["**/legacy/**"]\n');
    await handlePROpenedOrSync(prOpened(ws));

    const prompt = testEnv.gemini.generateCalls[0].prompt;
    expect(prompt).toContain("src/greet.ts");
    expect(prompt).not.toContain("src/legacy/old.ts");
    expect(summary()).toContain("1 file skipped by .ready2ship.yml");
  });

  it("DI-05 anInvalidFileCancelsTheReviewWithoutCallingTheModel", async () => {
    const ws = await setup();
    testEnv.github.putFile(REPO, ".ready2ship.yml", "main", "review:\n  mode: turbo\n");
    await handlePROpenedOrSync(prOpened(ws));

    expect(testEnv.gemini.generateCalls).toHaveLength(0);
    expect(testEnv.github.reviews).toHaveLength(0);
    expect(summary()).toContain("🛑 **Ready2Ship review cancelled:** .ready2ship.yml is invalid: review.mode must be lookout or dive");
    expect(summary()).toContain("then comment `@r2s-test retry`.");
    const doc = await pr();
    expect(doc?.status).toBe("cancelled");
    expect(doc?.lastReview?.cancelledReason).toMatch(/review\.mode/);
  });
});
