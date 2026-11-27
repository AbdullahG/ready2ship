import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { config } from "@/lib/config";
import { MAX_DIR_ENTRIES, MAX_FILE_BYTES, MAX_GREP_HITS, SourceError, sliceLines, type GrepHit, type RepoSource } from "./types";

const run = promisify(execFile);
const FETCH_TIMEOUT_MS = 60_000;
const GREP_TIMEOUT_MS = 10_000;

/** Git with no user/system config and no prompts; extra config goes in through env, never argv. */
function gitEnv(home: string, extraConfig: Record<string, string> = {}): NodeJS.ProcessEnv {
  const entries = Object.entries(extraConfig);
  return {
    PATH: config().systemPath,
    HOME: home,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: String(entries.length),
    ...Object.fromEntries(entries.flatMap(([k, v], i) => [[`GIT_CONFIG_KEY_${i}`, k], [`GIT_CONFIG_VALUE_${i}`, v]])),
  } as unknown as NodeJS.ProcessEnv; // deliberately minimal: no inherited secrets
}

/**
 * Shallow-fetches refs/pull/<n>/head (works for fork PRs too) into `dir`. The
 * installation token travels as an HTTP header set through the environment,
 * so it is in neither .git/config nor the process arguments.
 */
export async function createCloneSource(input: {
  dir: string;
  repoFullName: string;
  prNumber: number;
  token: string;
}): Promise<RepoSource> {
  const { dir, repoFullName, prNumber, token } = input;
  const repoDir = join(dir, "repo");
  await mkdir(repoDir, { recursive: true });
  const env = gitEnv(dir);
  const authEnv = gitEnv(dir, {
    "http.extraHeader": `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  });
  const url = `${config().github.webUrl}/${repoFullName}.git`;
  try {
    await run("git", ["init", "-q"], { cwd: repoDir, env });
    await run("git", ["fetch", "-q", "--depth", "1", "--no-tags", url, `refs/pull/${prNumber}/head`], {
      cwd: repoDir,
      env: authEnv,
      timeout: FETCH_TIMEOUT_MS,
    });
    await run("git", ["-c", "advice.detachedHead=false", "checkout", "-q", "FETCH_HEAD"], { cwd: repoDir, env });
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }

  const realRoot = await realpath(repoDir);
  const gitDir = join(realRoot, ".git");
  const inside = (p: string, root: string) => p === root || p.startsWith(root + sep);

  async function safePath(rel: string): Promise<string> {
    const abs = resolve(realRoot, rel);
    if (!inside(abs, realRoot) || inside(abs, gitDir)) throw new SourceError(`${rel} is outside the repository`);
    let real: string;
    try {
      real = await realpath(abs);
    } catch {
      throw new SourceError(`${rel}: not found`);
    }
    if (!inside(real, realRoot) || inside(real, gitDir)) throw new SourceError(`${rel} is outside the repository`);
    return real;
  }

  return {
    kind: "clone",
    root: repoDir,
    async listDir(path) {
      const abs = await safePath(path);
      const entries = await readdir(abs, { withFileTypes: true }).catch(() => {
        throw new SourceError(`${path}: not a directory`);
      });
      return entries
        .filter((e) => !(abs === realRoot && e.name === ".git"))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort()
        .slice(0, MAX_DIR_ENTRIES);
    },
    async readFile(path, start, end) {
      const abs = await safePath(path);
      const size = (await stat(abs)).size;
      if (size > MAX_FILE_BYTES) throw new SourceError(`${path} is too large to read (${Math.round(size / 1024 / 1024)} MB)`);
      const text = await readFile(abs, "utf-8").catch(() => {
        throw new SourceError(`${path}: not a readable file`);
      });
      return sliceLines(text, path, start, end);
    },
    async grep(pattern, pathGlob) {
      const args = ["grep", "-n", "-I", "--no-color", "-E", "-e", pattern];
      if (pathGlob) args.push("--", `:(glob)${pathGlob}`);
      let stdout: string;
      try {
        ({ stdout } = await run("git", args, { cwd: realRoot, env, timeout: GREP_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }));
      } catch (err) {
        // Exit code 1 means "no matches"; anything else is a bad pattern or a timeout.
        if ((err as { code?: number }).code === 1) return [];
        throw new SourceError(`grep failed for ${JSON.stringify(pattern)}`);
      }
      const hits: GrepHit[] = [];
      for (const line of stdout.split("\n")) {
        const m = /^(.*?):(\d+):(.*)$/.exec(line);
        if (m) hits.push({ path: m[1], line: Number(m[2]), text: m[3] });
        if (hits.length >= MAX_GREP_HITS) break;
      }
      return hits;
    },
    async dispose() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
