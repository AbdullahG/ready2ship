// Pure builders for everything Ready2Ship writes on GitHub. No I/O, so the
// exact wording is unit tested (test/unit/format.test.ts).
import { InvalidKeyError, QuotaError } from "@/lib/ai/errors";
import type { ReviewMode } from "@/lib/repo-config";
import type { PullRequest, ReviewResult, ReviewUsage } from "@/types";

type Finding = ReviewResult["findings"][number];
export type ReviewStats = PullRequest["reviewStats"];

export const STARTING_BODY =
  "👁️ **Ready2Ship Review** starting...\n\nReading the diff. This comment updates when findings are ready.";

export const retryHint = (appSlug: string) => `**To retry:** comment \`@${appSlug} retry\`.`;

const SEVERITY_BADGE: Record<string, string> = {
  blocker: "🔴 **[BLOCKER]**",
  minor: "🟡 **[MINOR]**",
  improvement: "💡 **[IMPROVEMENT]**",
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function noKeyBody(settingsUrl: string, appSlug: string): string {
  return `⚙️ **Ready2Ship** is installed but no AI key is configured, so this PR wasn't reviewed.\n\nA workspace owner can add a Gemini API key at ${settingsUrl}\n\n${retryHint(appSlug)}`;
}

/** The job ran out of attempts without finishing (crash, restart, or an unexpected error). */
export function interruptedBody(appSlug: string): string {
  return `⚠️ **Ready2Ship:** the review was interrupted before it finished.\n\n${retryHint(appSlug)}`;
}

export function reviewFailedBody(err: unknown, settingsUrl: string, appSlug: string, mode: ReviewMode = "lookout"): string {
  let reason: string;
  if (err instanceof InvalidKeyError) {
    reason = `The workspace's AI key was rejected by Google (${err.message}). A workspace owner can replace it at ${settingsUrl}`;
  } else if (err instanceof QuotaError) {
    reason = `The workspace's Gemini key has exceeded its quota or rate limit (${err.message}).`;
  } else if (err instanceof SyntaxError) {
    reason = "The AI model returned malformed output.";
  } else {
    reason = `Couldn't reach the AI service: ${(err as Error).message}`;
  }
  const what = err instanceof InvalidKeyError ? "the AI key was rejected" : "the AI review failed";
  const heading =
    mode === "dive"
      ? `🤿 **Ready2Ship Dive cancelled:** ${what}.`
      : err instanceof InvalidKeyError
        ? "⚠️ **Ready2Ship:** the AI key was rejected, so this PR wasn't reviewed."
        : "⚠️ **Ready2Ship:** the AI review failed.";
  return `${heading}\n\n**Reason:** ${reason}\n\n${retryHint(appSlug)}`;
}

export function inlineCommentBody(finding: Finding): string {
  const badge = SEVERITY_BADGE[finding.severity] ?? "•";
  // Description and suggestion share one paragraph so a short finding
  // doesn't render as three blocks.
  const suggestion = finding.suggestion?.trim();
  let body = suggestion ? `${badge} ${finding.description} ${suggestion}` : `${badge} ${finding.description}`;
  if (finding.fix?.original) {
    const replacementLine =
      finding.fix.replacement === ""
        ? `// ✅ Should be: (delete this line)`
        : `// ✅ Should be\n${finding.fix.replacement}`;
    body += `\n\n**Suggested fix:**\n\`\`\`\n// ❌ Now\n${finding.fix.original}\n\n${replacementLine}\n\`\`\`\n\n> Reply \`fix it\` to commit this change automatically.`;
  }
  return body;
}

export function reviewStats(findings: Finding[]): ReviewStats {
  return {
    blockers: findings.filter((f) => f.severity === "blocker").length,
    minors: findings.filter((f) => f.severity === "minor").length,
    improvements: findings.filter((f) => f.severity === "improvement").length,
    resolvedBlockers: 0,
  };
}

/** Body of the single GitHub review that carries the verdict and all inline comments. */
export function reviewVerdictBody(stats: ReviewStats, totalFindings: number): string {
  return stats.blockers === 0
    ? `✅ **Ready2Ship:** no blockers, PR approved.${totalFindings > 0 ? ` ${plural(totalFindings, "suggestion")} in the inline comments.` : ""}`
    : `🔴 **Ready2Ship:** ${plural(stats.blockers, "blocker")} found. Details in the inline comments and the summary.`;
}

export function summaryBody(result: ReviewResult, stats: ReviewStats): string {
  const total = result.findings.length;
  const statsLine =
    [
      stats.blockers > 0 ? `🔴 **${stats.blockers} Blocker**` : "",
      stats.minors > 0 ? `🟡 **${stats.minors} Minor**` : "",
      stats.improvements > 0 ? `💡 **${plural(stats.improvements, "Improvement")}**` : "",
    ]
      .filter(Boolean)
      .join(" · ") || "✅ Clean";

  const findingLines = result.findings
    .map((f) => {
      const icon = f.severity === "blocker" ? "🔴" : f.severity === "minor" ? "🟡" : "💡";
      const label = f.severity === "blocker" ? "Blocker" : f.severity === "minor" ? "Minor" : "Improvement";
      // One line per finding: the full description already lives in the inline comment.
      const fileRef = f.file ? ` · \`${f.file}:${f.startLine}${f.endLine !== f.startLine ? `-${f.endLine}` : ""}\`` : "";
      return `${icon} **${label}:** ${f.description}${fileRef}`;
    })
    .join("\n");

  const footerLine =
    stats.blockers === 0
      ? `> ✅ PR approved automatically.`
      : `> The PR gets approved automatically once every blocker is resolved.\n> Reply \`fix it\` on an inline comment to apply its fix.`;

  return (
    `## 🔍 Ready2Ship — Review complete\n\n` +
    `${result.summary}\n\n` +
    `---\n` +
    (total > 0 ? `⚠️ Changes requested · 0 of ${total} resolved\n\n` : `✅ No issues found\n\n`) +
    `${statsLine}\n\n` +
    (findingLines ? `${findingLines}\n\n` : "") +
    `---\n${footerLine}`
  );
}

// Parses each file's patch and returns the RIGHT-side line numbers (added +
// context lines) that GitHub accepts for inline review comments.
export function getCommentableLines(
  files: Array<{ filename: string; patch?: string }>
): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  for (const file of files) {
    if (!file.patch) continue;
    const lines = new Set<number>();
    let newLine = 0;
    for (const raw of file.patch.split("\n")) {
      const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) {
        newLine = parseInt(hunk[1], 10);
        continue;
      }
      if (raw.startsWith("-") || raw.startsWith("\\")) continue;
      lines.add(newLine);
      newLine++;
    }
    map.set(file.filename, lines);
  }
  return map;
}

/** 640 → "640", 12_345 → "12K", 2_000_000 → "2.0M". */
function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

export interface ReviewFooterInput {
  mode: ReviewMode;
  trigger: "auto" | "comment";
  usage: ReviewUsage | null;
  configSource: "file" | "default";
  warnings: string[];
  skippedByConfig: number;
}

/** Lines under the summary: config warnings, files left out, and what the review ran as and used. */
export function reviewFooter(f: ReviewFooterInput): string {
  const lines = f.warnings.map((w) => `⚠️ .ready2ship.yml: ${w}`);
  if (f.skippedByConfig > 0) lines.push(`${plural(f.skippedByConfig, "file")} skipped by .ready2ship.yml`);

  const parts: string[] = [f.mode === "dive" ? "🤿 Dive" : "🔭 Lookout"];
  const u = f.usage;
  if (f.mode === "dive" && u) {
    parts.push(plural(u.toolCalls ?? 0, "tool call"), `${plural(u.filesRead ?? 0, "file")} read`);
    if (u.droppedByVerification) parts.push(`${u.droppedByVerification} dropped by verification`);
  }
  if (u) parts.push(`~${compact(u.inputTokens)} input tokens`);
  if (f.mode === "dive" && u?.source) parts.push(`source: ${u.source === "api" ? "api (no grep)" : "clone"}`);
  if (f.trigger === "comment") parts.push("trigger: comment");
  parts.push(`config: ${f.configSource === "file" ? ".ready2ship.yml" : "default"}`);
  lines.push(parts.join(" · "));
  return lines.join("\n");
}

export function configInvalidBody(error: string, appSlug: string): string {
  return `🛑 **Ready2Ship review cancelled:** .ready2ship.yml is invalid: ${error}. Fix it on the default branch, then comment \`@${appSlug} retry\`.`;
}

/** `reason` says what ran out or failed; `hint` what to change. */
export function diveCancelledBody(reason: string, hint: string, appSlug: string): string {
  return `🤿 **Ready2Ship Dive cancelled:** ${reason}. ${hint}, then comment \`@${appSlug} retry\`.`;
}
