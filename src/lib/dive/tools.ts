import type { ToolCall, ToolDeclaration } from "@/lib/ai/providers/types";
import { isAlwaysSkipped } from "@/lib/ai/review";
import { SourceError, type RepoSource } from "./source";
import type { DiveBudget } from "./budget";

export interface ToolContext {
  source: RepoSource;
  budget: DiveBudget;
  /** .ready2ship.yml include/exclude. */
  inScope: (path: string) => boolean;
  maxLinesPerFile: number;
}

const LIST_DIR: ToolDeclaration = {
  name: "list_dir",
  description: 'List a directory of the repository at the PR head. Subdirectories end with "/". Use "" for the root.',
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};
const READ_FILE: ToolDeclaration = {
  name: "read_file",
  description: "Read a file at the PR head, with line numbers. Long files are cut; ask for a range with start_line/end_line.",
  parameters: {
    type: "object",
    properties: { path: { type: "string" }, start_line: { type: "integer" }, end_line: { type: "integer" } },
    required: ["path"],
  },
};
const GREP: ToolDeclaration = {
  name: "grep",
  description: "Search the repository at the PR head with an extended regular expression. Returns up to 100 matching lines.",
  parameters: {
    type: "object",
    properties: { pattern: { type: "string" }, path_glob: { type: "string", description: 'Optional, e.g. "src/**/*.ts"' } },
    required: ["pattern"],
  },
};

/** The tools this source supports: grep needs a checkout. */
export function diveTools(source: RepoSource): ToolDeclaration[] {
  return source.grep ? [LIST_DIR, READ_FILE, GREP] : [LIST_DIR, READ_FILE];
}

const str = (v: unknown) => (typeof v === "string" ? v : null);

/** Why the agent may not read `path`, or null if it may: built-in skips, then .ready2ship.yml. */
export function outOfScope(path: string, inScope: (path: string) => boolean): string | null {
  if (isAlwaysSkipped(path)) return `${path} is a lockfile, minified or generated file; Ready2Ship doesn't read those`;
  if (!inScope(path)) return `${path} is excluded by .ready2ship.yml`;
  return null;
}
const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined);

/**
 * Runs one tool call. Problems the model can fix (missing file, bad path,
 * excluded file) come back as `{ error }` for it to read; a spent budget throws.
 */
export async function executeTool(call: Pick<ToolCall, "name" | "args">, ctx: ToolContext): Promise<Record<string, unknown>> {
  ctx.budget.beforeToolCall();
  try {
    switch (call.name) {
      case "list_dir": {
        const path = str(call.args.path) ?? "";
        const entries = await ctx.source.listDir(path);
        const prefix = path.replace(/\/+$/, "");
        const full = (e: string) => (prefix ? `${prefix}/${e}` : e);
        return { entries: entries.filter((e) => e.endsWith("/") || !outOfScope(full(e), ctx.inScope)) };
      }
      case "read_file": {
        const path = str(call.args.path);
        if (!path) return { error: "read_file needs a string path" };
        const refused = outOfScope(path, ctx.inScope);
        if (refused) return { error: refused };
        const start = int(call.args.start_line) ?? 1;
        const end = Math.min(int(call.args.end_line) ?? Infinity, start + ctx.maxLinesPerFile - 1);
        const slice = await ctx.source.readFile(path, start, end);
        ctx.budget.readFile(path);
        const last = slice.startLine + slice.lines.length - 1;
        return {
          path,
          start_line: slice.startLine,
          end_line: last,
          total_lines: slice.totalLines,
          content: slice.lines.map((l, i) => `${slice.startLine + i}| ${l}`).join("\n"),
          ...(last < slice.totalLines && slice.lines.length >= ctx.maxLinesPerFile
            ? { note: `Showing at most ${ctx.maxLinesPerFile} lines. Request another range with start_line/end_line.` }
            : {}),
        };
      }
      case "grep": {
        if (!ctx.source.grep) return { error: "grep is not available for this repository" };
        const pattern = str(call.args.pattern);
        if (!pattern) return { error: "grep needs a string pattern" };
        const hits = await ctx.source.grep(pattern, str(call.args.path_glob) ?? undefined);
        return { matches: hits.filter((h) => !outOfScope(h.path, ctx.inScope)) };
      }
      default:
        return { error: `unknown tool ${call.name}` };
    }
  } catch (err) {
    if (err instanceof SourceError) return { error: err.message };
    throw err;
  }
}
