import { describe, expect, it } from "vitest";
import { DIVE_DEFAULTS, makePathFilter, parseRepoConfig } from "@/lib/repo-config";

function ok(text: string | null) {
  const r = parseRepoConfig(text);
  if (!r.ok) throw new Error(`expected a valid config, got: ${r.error}`);
  return r.config;
}
function err(text: string) {
  const r = parseRepoConfig(text);
  if (r.ok) throw new Error(`expected an error for:\n${text}`);
  return r.error;
}

describe("parseRepoConfig", () => {
  it("DU-05 noFileMeansLookoutWithCodeDefaults", () => {
    expect(ok(null)).toEqual({
      mode: "lookout",
      include: [],
      exclude: [],
      dive: { ...DIVE_DEFAULTS },
      source: "default",
      warnings: [],
    });
    expect(DIVE_DEFAULTS).toEqual({ models: [], maxToolCalls: 50, maxFiles: 100, maxLinesPerFile: 5000, maxInputTokens: 2_000_000 });
  });

  it("DU-05 aFileOverridesOnlyTheFieldsItSets", () => {
    const c = ok("review:\n  mode: dive\ndive:\n  maxToolCalls: 80\n  models: [gemini-2.5-pro]\n");
    expect(c.mode).toBe("dive");
    expect(c.source).toBe("file");
    expect(c.dive).toEqual({ ...DIVE_DEFAULTS, maxToolCalls: 80, models: ["gemini-2.5-pro"] });
  });

  it("DU-05 anEmptyFileIsValidAndUsesDefaults", () => {
    expect(ok("")).toMatchObject({ mode: "lookout", source: "file", warnings: [] });
    expect(ok("# just a comment\n")).toMatchObject({ mode: "lookout", source: "file" });
  });

  it.each([
    ["dive", "dive"],
    ["deep", "dive"],
    ["DEEP", "dive"],
    ["lookout", "lookout"],
    ["quick", "lookout"],
    [" Quick ", "lookout"],
  ])("DU-01 mode %j means %s", (value, mode) => {
    expect(ok(`review:\n  mode: "${value}"\n`).mode).toBe(mode);
  });

  it("DU-02 readsIncludeAndExcludeGlobs", () => {
    const c = ok('review:\n  include: ["**/*.java"]\n  exclude: ["**/generated/**"]\n');
    expect(c.include).toEqual(["**/*.java"]);
    expect(c.exclude).toEqual(["**/generated/**"]);
  });

  it.each([
    ["review: [", /YAML/i],
    ["- a\n- b\n", /mapping/],
    ["review:\n  mode: turbo\n", /review\.mode.*turbo/],
    ["review:\n  include: '**/*.java'\n", /review\.include.*list/],
    ["review:\n  exclude: [1]\n", /review\.exclude.*list/],
    ["dive:\n  maxToolCalls: 0\n", /dive\.maxToolCalls.*whole number/],
    ["dive:\n  maxFiles: -3\n", /dive\.maxFiles/],
    ["dive:\n  maxLinesPerFile: 2.5\n", /dive\.maxLinesPerFile/],
    ["dive:\n  maxInputTokens: lots\n", /dive\.maxInputTokens/],
    ["dive:\n  models: gemini-2.5-pro\n", /dive\.models.*list/],
    ["dive:\n  models: ['']\n", /dive\.models/],
    ["review: 3\n", /review.*mapping/],
  ])("DU-04 rejects %j", (text, message) => {
    expect(err(text)).toMatch(message);
  });

  it("DU-04 aYamlSyntaxErrorReadsAsOneCleanSentence", () => {
    const message = err("review: [");
    expect(message).toMatch(/^not valid YAML \(.+ at line 1, column \d+\)$/);
    expect(message).not.toMatch(/:\)$/);
  });

  it("DU-04 unknownKeysAreWarningsNotErrors", () => {
    const c = ok("review:\n  mode: dive\n  speed: fast\nnotes: hi\n");
    expect(c.mode).toBe("dive");
    expect(c.warnings).toEqual(["unknown key review.speed", "unknown key notes"]);
  });
});

describe("makePathFilter", () => {
  it("DU-03 emptyIncludeLetsEverythingThroughExceptExcludes", () => {
    const keep = makePathFilter({ include: [], exclude: ["**/generated/**"] });
    expect(keep("src/a.ts")).toBe(true);
    expect(keep(".github/workflows/ci.yml")).toBe(true);
    expect(keep("src/generated/api.ts")).toBe(false);
  });

  it("DU-03 includeNarrowsAndExcludeWinsOverInclude", () => {
    const keep = makePathFilter({ include: ["**/*.java"], exclude: ["**/legacy/**"] });
    expect(keep("src/main/App.java")).toBe(true);
    expect(keep("App.java")).toBe(true);
    expect(keep("src/main/app.ts")).toBe(false);
    expect(keep("src/legacy/Old.java")).toBe(false);
  });
});

describe("docs/review-modes.md", () => {
  it("DU-09 theDocumentedExampleIsAValidConfig", async () => {
    const { readFileSync } = await import("node:fs");
    const doc = readFileSync(new URL("../../docs/review-modes.md", import.meta.url), "utf-8");
    const example = /```yaml\n([\s\S]*?)```/.exec(doc)![1];
    const c = ok(example);
    expect(c).toMatchObject({ mode: "dive", include: ["**/*.java"], exclude: ["**/generated/**"], warnings: [] });
    expect(c.dive).toEqual({ models: ["gemini-2.5-pro"], maxToolCalls: 50, maxFiles: 100, maxLinesPerFile: 5000, maxInputTokens: 2_000_000 });
    // The options table documents the same defaults the code uses.
    for (const [key, value] of Object.entries(DIVE_DEFAULTS)) {
      if (key === "models") continue;
      expect(doc).toContain(`| \`dive.${key}\` | ${(value as number).toLocaleString("en-US")} |`);
    }
  });
});
