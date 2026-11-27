import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { MAX_FILE_BYTES, createRepoSource, removeStaleCheckouts, type RepoSource } from "@/lib/dive/source";
import { buildGitRepo, type GitRepo } from "../fakes/git-repo";
import { testEnv } from "./env";

const REPO = "acme/app";
const INSTALLATION = 77;
let repo: GitRepo | null = null;
let source: RepoSource | null = null;

afterEach(async () => {
  await source?.dispose();
  source = null;
  repo?.cleanup();
  repo = null;
});

function seed(extra: Partial<Parameters<typeof buildGitRepo>[0]> = {}) {
  testEnv.github.addInstallation({ id: INSTALLATION, accountLogin: "acme" });
  repo = buildGitRepo({
    base: {
      "src/greet.ts": "export function greet(name) {\n  return name;\n}\n",
      "src/util/strings.ts": "export const trimAll = (s: string[]) => s.map((x) => x.trim());\n",
      "README.md": "# app\n",
    },
    pulls: { 7: { "src/greet.ts": "export function greet(name) {\n  return name.trim();\n}\n" } },
    ...extra,
  });
  testEnv.github.gitRepos.set(REPO, repo.gitDir);
  return repo;
}

const open = async (prNumber = 7) =>
  (source = await createRepoSource({ installationId: INSTALLATION, repoFullName: REPO, prNumber, headSha: repo!.headSha(prNumber), jobId: `job-${prNumber}` }));

describe("clone source", () => {
  it("DI-21 readsListsAndGrepsThePullRequestHead", async () => {
    seed();
    const s = await open();
    expect(s.kind).toBe("clone");

    const file = await s.readFile("src/greet.ts");
    expect(file.lines).toEqual(["export function greet(name) {", "  return name.trim();", "}"]);
    expect(file.totalLines).toBe(3);
    expect(await s.readFile("src/greet.ts", 2, 2)).toMatchObject({ lines: ["  return name.trim();"], startLine: 2 });

    expect(await s.listDir("")).toEqual(expect.arrayContaining(["README.md", "src/"]));
    expect(await s.listDir("src")).toEqual(["greet.ts", "util/"]);

    expect(await s.grep!("trim\\(")).toEqual([
      { path: "src/greet.ts", line: 2, text: "  return name.trim();" },
      { path: "src/util/strings.ts", line: 1, text: "export const trimAll = (s: string[]) => s.map((x) => x.trim());" },
    ]);
    expect(await s.grep!("trim\\(", "src/util/**")).toHaveLength(1);
    expect(await s.grep!("no-such-text")).toEqual([]);
  });

  it("DI-21 disposeRemovesTheCheckout", async () => {
    seed();
    const s = await open();
    const root = s.root!;
    expect(existsSync(root)).toBe(true);
    await s.dispose();
    source = null;
    expect(existsSync(root)).toBe(false);
  });

  it("DI-20 pathsOutsideTheCheckoutAreRefused", async () => {
    seed({ symlinks: { "src/escape": "/etc/hosts" } });
    const s = await open();
    await expect(s.readFile("../outside.txt")).rejects.toThrow(/outside the repository/);
    await expect(s.readFile("src/escape")).rejects.toThrow(/outside the repository/);
    await expect(s.readFile(".git/config")).rejects.toThrow(/outside the repository/);
    await expect(s.listDir("../")).rejects.toThrow(/outside the repository/);
    await expect(s.readFile("src/missing.ts")).rejects.toThrow(/not found/);
  });

  it("DI-22 theHeadIsFetchedFromTheBaseRepoPullRef", async () => {
    // Fork PRs only exist in the base repo as refs/pull/<n>/head.
    seed({ pulls: { 9: { "src/fork.ts": "export const fromFork = true;\n" } } });
    const s = await open(9);
    expect((await s.readFile("src/fork.ts")).lines).toEqual(["export const fromFork = true;"]);
  });

  it("DI-15 theTokenTravelsInAHeaderAndIsNeverWrittenOrLogged", async () => {
    seed();
    const logged: string[] = [];
    for (const level of ["log", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
    }
    const s = await open();
    vi.restoreAllMocks();

    const expected = `Basic ${Buffer.from(`x-access-token:inst-${INSTALLATION}`).toString("base64")}`;
    expect(testEnv.github.gitAuthHeaders.length).toBeGreaterThan(0);
    expect(new Set(testEnv.github.gitAuthHeaders)).toEqual(new Set([expected]));
    // Nowhere in the checkout: not .git/config, not FETCH_HEAD, not any other file git wrote.
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        return statSync(p).isDirectory() ? files(p) : [p];
      });
    // Neither the token nor the header value git sends, anywhere in the checkout's directory (HOME included).
    const header = Buffer.from(`x-access-token:inst-${INSTALLATION}`).toString("base64");
    const leaking = files(join(s.root!, "..")).filter((f) => {
      const text = readFileSync(f);
      return text.includes(`inst-${INSTALLATION}`) || text.includes(header);
    });
    expect(leaking).toEqual([]);
    expect(logged.join("\n")).not.toContain(`inst-${INSTALLATION}`);
  });
});

describe("clone source limits", () => {
  it("DI-21 aFileOverTheSizeCapIsRefusedWithoutReadingIt", async () => {
    seed({ base: { "big.txt": "x".repeat(MAX_FILE_BYTES + 1), "README.md": "# app\n" } });
    const s = await open();
    await expect(s.readFile("big.txt")).rejects.toThrow(/too large/);
  });

  it("DI-26 startupCleanupRemovesOnlyAbandonedCheckouts", async () => {
    const root = join(tmpdir(), "r2s-dive");
    const old = join(root, "old-job-x");
    const live = join(root, "live-job-y");
    mkdirSync(old, { recursive: true });
    mkdirSync(live, { recursive: true });
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
    utimesSync(old, twoHoursAgo, twoHoursAgo);
    await removeStaleCheckouts();
    expect(existsSync(old)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });
});

describe("api fallback", () => {
  it("DI-13 aRepoOverTheSizeCapIsReadThroughTheApiWithoutGrep", async () => {
    seed();
    testEnv.github.repos.set(REPO, { defaultBranch: "main", sizeKb: 600 * 1024 });
    const s = await open();
    expect(s.kind).toBe("api");
    expect(s.grep).toBeUndefined();
    expect(testEnv.github.gitAuthHeaders).toEqual([]);
    expect((await s.readFile("src/greet.ts")).lines[1]).toBe("  return name.trim();");
    expect(await s.listDir("src")).toEqual(["greet.ts", "util/"]);
    await expect(s.readFile("src/missing.ts")).rejects.toThrow(/not found/);
  });

  it("DI-14 aFailedCloneFallsBackToTheApi", async () => {
    seed();
    testEnv.github.gitDown = true;
    const warned: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void warned.push(args.map(String).join(" ")));
    const s = await open();
    vi.restoreAllMocks();
    expect(s.kind).toBe("api");
    // The failure is logged with git's reason, and the token is not in it.
    expect(warned.join("\n")).toMatch(/dive\.source_fallback.*clone failed/);
    expect(warned.join("\n")).not.toContain(`inst-${INSTALLATION}`);
    expect((await s.readFile("README.md")).lines).toEqual(["# app"]);
  });
});
