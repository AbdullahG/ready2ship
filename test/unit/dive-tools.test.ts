import { describe, expect, it } from "vitest";
import { diveTools, executeTool } from "@/lib/dive/tools";
import { DiveBudget, DiveCancelledError } from "@/lib/dive/budget";
import { SourceError, type RepoSource } from "@/lib/dive/source";
import { DIVE_DEFAULTS, makePathFilter } from "@/lib/repo-config";

// An in-memory source: the real ones are covered by repo-source.int.test.ts.
function memorySource(files: Record<string, string>, withGrep = true): RepoSource {
  return {
    kind: withGrep ? "clone" : "api",
    async listDir(path) {
      const prefix = path ? `${path}/` : "";
      const names = new Set<string>();
      for (const f of Object.keys(files)) {
        if (!f.startsWith(prefix)) continue;
        const rest = f.slice(prefix.length);
        names.add(rest.includes("/") ? `${rest.split("/")[0]}/` : rest);
      }
      return [...names].sort();
    },
    async readFile(path, start, end) {
      const text = files[path];
      if (text === undefined) throw new SourceError(`${path}: not found`);
      const all = text.split("\n");
      const from = start ?? 1;
      const to = Math.min(all.length, end ?? all.length);
      return { lines: all.slice(from - 1, to), startLine: from, totalLines: all.length };
    },
    ...(withGrep
      ? {
          async grep(pattern: string) {
            const re = new RegExp(pattern);
            return Object.entries(files).flatMap(([path, text]) =>
              text.split("\n").flatMap((t, i) => (re.test(t) ? [{ path, line: i + 1, text: t }] : []))
            );
          },
        }
      : {}),
    async dispose() {},
  };
}

const FILES = {
  "src/a.ts": Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n"),
  "src/b.ts": "const token = 1;",
  "vendor/x.ts": "const token = 2;",
  "package-lock.json": '{ "token": 3 }',
};

function ctx(o: { maxLinesPerFile?: number; exclude?: string[]; grep?: boolean } = {}) {
  return {
    source: memorySource(FILES, o.grep ?? true),
    budget: new DiveBudget({ ...DIVE_DEFAULTS, maxLinesPerFile: o.maxLinesPerFile ?? 5000 }),
    inScope: makePathFilter({ include: [], exclude: o.exclude ?? [] }),
    maxLinesPerFile: o.maxLinesPerFile ?? 5000,
  };
}

describe("dive tools", () => {
  it("DU-11 grepIsOfferedOnlyWhenTheSourceCanGrep", () => {
    expect(diveTools(memorySource(FILES)).map((t) => t.name)).toEqual(["list_dir", "read_file", "grep"]);
    expect(diveTools(memorySource(FILES, false)).map((t) => t.name)).toEqual(["list_dir", "read_file"]);
  });

  it("DU-11 readFileReturnsNumberedLinesAndCapsAtMaxLinesPerFile", async () => {
    const c = ctx({ maxLinesPerFile: 4 });
    const out = await executeTool({ name: "read_file", args: { path: "src/a.ts", start_line: 3 } }, c);
    expect(out).toEqual({
      path: "src/a.ts",
      start_line: 3,
      end_line: 6,
      total_lines: 10,
      content: "3| line 3\n4| line 4\n5| line 5\n6| line 6",
      note: "Showing at most 4 lines. Request another range with start_line/end_line.",
    });
    await executeTool({ name: "read_file", args: { path: "src/a.ts", start_line: 7 } }, c);
    expect(c.budget.usage()).toMatchObject({ toolCalls: 2, filesRead: 1 });
  });

  it("DU-11 excludedFilesAreRefusedAndNotCounted", async () => {
    const c = ctx({ exclude: ["vendor/**"] });
    expect(await executeTool({ name: "read_file", args: { path: "vendor/x.ts" } }, c)).toEqual({ error: "vendor/x.ts is excluded by .ready2ship.yml" });
    expect(c.budget.usage().filesRead).toBe(0);
    expect(await executeTool({ name: "grep", args: { pattern: "token" } }, c)).toEqual({
      matches: [{ path: "src/b.ts", line: 1, text: "const token = 1;" }],
    });
    expect(await executeTool({ name: "list_dir", args: { path: "" } }, c)).toEqual({ entries: ["src/", "vendor/"] });
  });

  it("DU-11 lockfilesAndGeneratedFilesAreNeverReadEvenWithoutAnExclude", async () => {
    const c = ctx();
    expect(await executeTool({ name: "read_file", args: { path: "package-lock.json" } }, c)).toEqual({
      error: "package-lock.json is a lockfile, minified or generated file; Ready2Ship doesn't read those",
    });
    expect(c.budget.usage().filesRead).toBe(0);
    const grep = (await executeTool({ name: "grep", args: { pattern: "token" } }, c)) as { matches: Array<{ path: string }> };
    expect(grep.matches.map((m) => m.path)).not.toContain("package-lock.json");
    expect(await executeTool({ name: "list_dir", args: { path: "" } }, c)).toEqual({ entries: ["src/", "vendor/"] });
  });

  it("DU-11 sourceErrorsGoBackToTheModelAsToolErrors", async () => {
    const c = ctx();
    expect(await executeTool({ name: "read_file", args: { path: "nope.ts" } }, c)).toEqual({ error: "nope.ts: not found" });
    expect(await executeTool({ name: "read_file", args: {} }, c)).toEqual({ error: "read_file needs a string path" });
    expect(await executeTool({ name: "grep", args: { pattern: "x" } }, ctx({ grep: false }))).toEqual({ error: "grep is not available for this repository" });
    expect(await executeTool({ name: "rm_rf", args: {} }, c)).toEqual({ error: "unknown tool rm_rf" });
  });

  it("DU-11 everyCallCountsAgainstTheToolCallCap", async () => {
    const c = { ...ctx(), budget: new DiveBudget({ ...DIVE_DEFAULTS, maxToolCalls: 1 }) };
    await executeTool({ name: "list_dir", args: { path: "" } }, c);
    await expect(executeTool({ name: "list_dir", args: { path: "" } }, c)).rejects.toBeInstanceOf(DiveCancelledError);
  });
});
