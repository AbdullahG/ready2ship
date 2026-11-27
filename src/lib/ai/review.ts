import type { AIProvider } from "./providers/types";
import { buildReviewPrompt } from "./prompts";
import type { ReviewResult, ReviewUsage } from "@/types";

const MAX_DIFF_CHARS = 60_000;

export async function reviewPRDiff(
  provider: AIProvider,
  prTitle: string,
  prBody: string,
  diff: string
): Promise<{ result: ReviewResult; usage: ReviewUsage }> {
  const truncatedDiff =
    diff.length > MAX_DIFF_CHARS
      ? diff.slice(0, MAX_DIFF_CHARS) + "\n\n[diff truncated]"
      : diff;

  const prompt = buildReviewPrompt(prTitle, prBody, truncatedDiff);
  const { text, usage } = await provider.generateWithUsage(prompt);
  return { result: parseReviewJson(text), usage };
}

/** Parses the model's review JSON; throws SyntaxError on malformed output. */
export function parseReviewJson(text: string): ReviewResult {
  // Tolerate a "Here is the JSON:" preamble or a code fence: keep only the
  // outermost object.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const jsonText = start !== -1 && end > start ? text.slice(start, end + 1) : text;

  const parsed = JSON.parse(jsonText) as ReviewResult;

  parsed.findings = (parsed.findings ?? []).filter(
    (f) =>
      f.severity &&
      f.file &&
      typeof f.startLine === "number" &&
      f.description
  );

  return parsed;
}

const SKIP_FILE_PATTERNS = [
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Gemfile\.lock|Cargo\.lock|go\.sum)$/,
  /\.min\.(js|css)$/,
  /\.(map|snap|lock)$/,
  /(^|\/)(dist|build|out|\.next|node_modules)\//,
  /\.generated\.|(^|\/)generated\//,
];

/** Files whose diff is never reviewed: lockfiles, minified and generated output. */
export function isAlwaysSkipped(path: string): boolean {
  return SKIP_FILE_PATTERNS.some((p) => p.test(path));
}

/** `inScope` is the repo's include/exclude filter from .ready2ship.yml. */
export function buildDiffFromFiles(
  files: Array<{ filename: string; patch?: string }>,
  inScope: (path: string) => boolean = () => true
): string {
  return files
    .filter((f) => f.patch && !isAlwaysSkipped(f.filename) && inScope(f.filename))
    .map((f) => `--- a/${f.filename}\n+++ b/${f.filename}\n${addLineNumbersToDiff(f.patch!)}`)
    .join("\n\n");
}

function addLineNumbersToDiff(diff: string): string {
  let newLine = 0;
  return diff
    .split("\n")
    .map((line) => {
      const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) {
        newLine = parseInt(hunk[1], 10);
        return line;
      }
      if (line.startsWith("+") || line.startsWith(" ")) {
        return `${String(newLine++).padStart(5)} ${line}`;
      }
      return `      ${line}`;
    })
    .join("\n");
}
