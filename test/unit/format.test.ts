import { describe, expect, it } from "vitest";
import {
  STARTING_BODY,
  retryHint,
  interruptedBody,
  getCommentableLines,
  inlineCommentBody,
  noKeyBody,
  reviewFailedBody,
  reviewStats,
  reviewVerdictBody,
  summaryBody, reviewFooter, configInvalidBody, diveCancelledBody } from "@/lib/github/pipeline/format";
import { InvalidKeyError, QuotaError } from "@/lib/ai/errors";
import type { ReviewResult } from "@/types";

type Finding = ReviewResult["findings"][number];

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  severity: "blocker",
  file: "src/a.ts",
  startLine: 3,
  endLine: 3,
  description: "Null dereference.",
  suggestion: "Guard it.",
  ...overrides,
});

const SETTINGS = "https://r2s.example/w/abc/settings";

describe("PR comment formatting (U-07)", () => {
  it("startingAndRetryTextsAreUnchanged", () => {
    expect(STARTING_BODY).toBe(
      "👁️ **Ready2Ship Review** starting...\n\nReading the diff. This comment updates when findings are ready."
    );
    // Changed on request (2026-11-24): retrying is a comment command, no more empty commits.
    expect(retryHint("my-app")).toBe("**To retry:** comment `@my-app retry`.");
  });

  it("noKeyBodyPointsToSettings", () => {
    expect(noKeyBody(SETTINGS, "my-app")).toBe(
      `⚙️ **Ready2Ship** is installed but no AI key is configured, so this PR wasn't reviewed.\n\nA workspace owner can add a Gemini API key at ${SETTINGS}\n\n**To retry:** comment \`@my-app retry\`.`
    );
  });

  it.each([
    [
      new InvalidKeyError("API key not valid."),
      "⚠️ **Ready2Ship:** the AI key was rejected, so this PR wasn't reviewed.",
      `The workspace's AI key was rejected by Google (API key not valid.). A workspace owner can replace it at ${SETTINGS}`,
    ],
    [
      new QuotaError("Resource exhausted."),
      "⚠️ **Ready2Ship:** the AI review failed.",
      "The workspace's Gemini key has exceeded its quota or rate limit (Resource exhausted.).",
    ],
    [new SyntaxError("bad json"), "⚠️ **Ready2Ship:** the AI review failed.", "The AI model returned malformed output."],
    [new Error("socket hang up"), "⚠️ **Ready2Ship:** the AI review failed.", "Couldn't reach the AI service: socket hang up"],
  ])("reviewFailedBody %#", (err, heading, reason) => {
    expect(reviewFailedBody(err, SETTINGS, "my-app")).toBe(`${heading}\n\n**Reason:** ${reason}\n\n**To retry:** comment \`@my-app retry\`.`);
  });

  it("DU-15 interruptedBodyTellsHowToRetry", () => {
    expect(interruptedBody("my-app")).toBe(
      "⚠️ **Ready2Ship:** the review was interrupted before it finished.\n\n**To retry:** comment `@my-app retry`."
    );
  });

  it("inlineCommentWithoutFixKeepsDescriptionAndSuggestionInOneParagraph", () => {
    expect(inlineCommentBody(finding())).toBe("🔴 **[BLOCKER]** Null dereference. Guard it.");
    expect(inlineCommentBody(finding({ severity: "minor", suggestion: "  " }))).toBe("🟡 **[MINOR]** Null dereference.");
    expect(inlineCommentBody(finding({ severity: "improvement", suggestion: "" }))).toBe(
      "💡 **[IMPROVEMENT]** Null dereference."
    );
  });

  it("inlineCommentWithFixShowsBeforeAfterAndTheCommand", () => {
    expect(inlineCommentBody(finding({ fix: { original: "a.trim()", replacement: "(a ?? '').trim()" } }))).toBe(
      "🔴 **[BLOCKER]** Null dereference. Guard it.\n\n**Suggested fix:**\n```\n// ❌ Now\na.trim()\n\n// ✅ Should be\n(a ?? '').trim()\n```\n\n> Reply `fix it` to commit this change automatically."
    );
  });

  it("inlineCommentForALineDeletion", () => {
    expect(inlineCommentBody(finding({ fix: { original: "console.log(x);", replacement: "" } }))).toContain(
      "// ❌ Now\nconsole.log(x);\n\n// ✅ Should be: (delete this line)\n```"
    );
  });

  it("reviewStatsCountsBySeverity", () => {
    expect(
      reviewStats([finding(), finding({ severity: "minor" }), finding({ severity: "improvement" }), finding({ severity: "improvement" })])
    ).toEqual({ blockers: 1, minors: 1, improvements: 2, resolvedBlockers: 0 });
  });

  it("verdictBody", () => {
    expect(reviewVerdictBody(reviewStats([]), 0)).toBe("✅ **Ready2Ship:** no blockers, PR approved.");
    expect(reviewVerdictBody(reviewStats([finding({ severity: "minor" })]), 1)).toBe(
      "✅ **Ready2Ship:** no blockers, PR approved. 1 suggestion in the inline comments."
    );
    expect(reviewVerdictBody(reviewStats([finding({ severity: "minor" }), finding({ severity: "minor" })]), 2)).toBe(
      "✅ **Ready2Ship:** no blockers, PR approved. 2 suggestions in the inline comments."
    );
    expect(reviewVerdictBody(reviewStats([finding()]), 1)).toBe(
      "🔴 **Ready2Ship:** 1 blocker found. Details in the inline comments and the summary."
    );
    expect(reviewVerdictBody(reviewStats([finding(), finding()]), 2)).toBe(
      "🔴 **Ready2Ship:** 2 blockers found. Details in the inline comments and the summary."
    );
  });

  it("summaryBodyWithBlockers", () => {
    const result: ReviewResult = {
      summary: "Adds a helper.",
      findings: [finding(), finding({ severity: "improvement", startLine: 5, endLine: 8, description: "Rename." })],
    };
    expect(summaryBody(result, reviewStats(result.findings))).toBe(
      "## 🔍 Ready2Ship — Review complete\n\nAdds a helper.\n\n---\n⚠️ Changes requested · 0 of 2 resolved\n\n" +
        "🔴 **1 Blocker** · 💡 **1 Improvement**\n\n" +
        "🔴 **Blocker:** Null dereference. · `src/a.ts:3`\n💡 **Improvement:** Rename. · `src/a.ts:5-8`\n\n" +
        "---\n> The PR gets approved automatically once every blocker is resolved.\n> Reply `fix it` on an inline comment to apply its fix."
    );
  });

  it("summaryBodyWhenClean", () => {
    const result: ReviewResult = { summary: "Looks good.", findings: [] };
    expect(summaryBody(result, reviewStats([]))).toBe(
      "## 🔍 Ready2Ship — Review complete\n\nLooks good.\n\n---\n✅ No issues found\n\n✅ Clean\n\n---\n> ✅ PR approved automatically."
    );
  });

  it("commentableLinesCoverAddedAndContextLinesAcrossHunks", () => {
    const patch = [
      "@@ -1,3 +1,4 @@",
      " keep1",
      "-gone",
      "+new2",
      "+new3",
      " keep4",
      "@@ -10,2 +11,2 @@",
      " keep11",
      "+new12",
      "\\ No newline at end of file",
    ].join("\n");
    const map = getCommentableLines([{ filename: "a.ts", patch }, { filename: "bin.png" }]);
    expect([...map.get("a.ts")!].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 11, 12]);
    expect(map.has("bin.png")).toBe(false);
  });
});

describe("review footer and cancel bodies", () => {
  const base = { trigger: "auto" as const, configSource: "default" as const, warnings: [], skippedByConfig: 0 };

  it("DU-12 lookoutShowsModeTokensAndConfigSource", () => {
    expect(reviewFooter({ ...base, mode: "lookout", usage: { inputTokens: 12_345, outputTokens: 50 } })).toBe(
      "🔭 Lookout · ~12K input tokens · config: default"
    );
  });

  it("DU-12 diveShowsToolUseSourceAndTrigger", () => {
    expect(
      reviewFooter({
        ...base,
        mode: "dive",
        trigger: "comment",
        configSource: "file",
        usage: { inputTokens: 640_000, outputTokens: 900, toolCalls: 23, filesRead: 1, droppedByVerification: 2, source: "api" },
      })
    ).toBe(
      "🤿 Dive · 23 tool calls · 1 file read · 2 dropped by verification · ~640K input tokens · source: api (no grep) · trigger: comment · config: .ready2ship.yml"
    );
    expect(reviewFooter({ ...base, mode: "dive", usage: { inputTokens: 2_000_000, outputTokens: 1, toolCalls: 1, filesRead: 0, source: "clone" } })).toBe(
      "🤿 Dive · 1 tool call · 0 files read · ~2.0M input tokens · source: clone · config: default"
    );
  });

  it("DU-12 warningsAndSkippedFilesComeFirst", () => {
    expect(
      reviewFooter({ ...base, mode: "lookout", usage: null, warnings: ["unknown key notes"], skippedByConfig: 3 })
    ).toBe("⚠️ .ready2ship.yml: unknown key notes\n3 files skipped by .ready2ship.yml\n🔭 Lookout · config: default");
  });

  it("DU-13 cancelBodiesSayWhyAndHowToRetry", () => {
    expect(configInvalidBody("review.mode must be lookout or dive", "my-app")).toBe(
      '🛑 **Ready2Ship review cancelled:** .ready2ship.yml is invalid: review.mode must be lookout or dive. Fix it on the default branch, then comment `@my-app retry`.'
    );
    expect(diveCancelledBody("used 2,000,000 of 2,000,000 input tokens before finishing", "Raise dive.maxInputTokens in .ready2ship.yml or narrow review.include", "my-app")).toBe(
      '🤿 **Ready2Ship Dive cancelled:** used 2,000,000 of 2,000,000 input tokens before finishing. Raise dive.maxInputTokens in .ready2ship.yml or narrow review.include, then comment `@my-app retry`.'
    );
  });
});
