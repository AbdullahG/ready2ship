// Builds a real git repository on disk for the fake GitHub to serve:
// a default branch plus one head commit per pull request, published under
// refs/pull/<n>/head like GitHub does (so fork PRs work the same way).
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface GitRepoSpec {
  defaultBranch?: string;
  /** Files on the default branch. */
  base: Record<string, string>;
  /** Per PR number: files to change (null deletes) on top of the default branch. */
  pulls?: Record<number, Record<string, string | null>>;
  /** Symlinks to create on the default branch: path → target. */
  symlinks?: Record<string, string>;
}

export interface GitRepo {
  /** Bare repository served over HTTP. */
  gitDir: string;
  defaultBranch: string;
  headSha(prNumber: number): string;
  cleanup(): void;
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Fake",
  GIT_AUTHOR_EMAIL: "fake@example.com",
  GIT_COMMITTER_NAME: "Fake",
  GIT_COMMITTER_EMAIL: "fake@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
  HOME: tmpdir(),
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf-8" }).trim();
}

function writeFiles(root: string, files: Record<string, string | null>): void {
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, path);
    if (content === null) {
      rmSync(abs, { force: true });
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

export function buildGitRepo(spec: GitRepoSpec): GitRepo {
  const defaultBranch = spec.defaultBranch ?? "main";
  const root = mkdtempSync(join(tmpdir(), "r2s-fake-repo-"));
  const work = join(root, "work");
  mkdirSync(work);
  git(work, "init", "-q", "-b", defaultBranch);
  writeFiles(work, spec.base);
  for (const [path, target] of Object.entries(spec.symlinks ?? {})) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    symlinkSync(target, join(work, path));
  }
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "base");

  const heads = new Map<number, string>();
  for (const [n, files] of Object.entries(spec.pulls ?? {})) {
    git(work, "checkout", "-q", "-b", `pr-${n}`, defaultBranch);
    writeFiles(work, files);
    git(work, "add", "-A");
    git(work, "commit", "-q", "--allow-empty", "-m", `pr ${n}`);
    const sha = git(work, "rev-parse", "HEAD");
    git(work, "update-ref", `refs/pull/${n}/head`, sha);
    heads.set(Number(n), sha);
  }
  git(work, "checkout", "-q", defaultBranch);

  const gitDir = join(root, "repo.git");
  git(root, "clone", "-q", "--mirror", work, gitDir);
  return {
    gitDir,
    defaultBranch,
    headSha: (n) => {
      const sha = heads.get(n);
      if (!sha) throw new Error(`fake repo has no PR #${n}`);
      return sha;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** `git show <ref>:<path>`, or null when the path isn't a file at that ref. */
export function gitShow(gitDir: string, ref: string, path: string): string | null {
  try {
    return execFileSync("git", ["--git-dir", gitDir, "show", `${ref}:${path}`], { env: GIT_ENV, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/** Every path at `ref` with its type, like GitHub's recursive tree. */
export function gitTree(gitDir: string, ref: string): Array<{ path: string; type: "blob" | "tree" }> {
  const out = execFileSync("git", ["--git-dir", gitDir, "ls-tree", "-r", "-t", ref], { env: GIT_ENV, encoding: "utf-8" });
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split("\t");
      return { path, type: meta.split(" ")[1] === "tree" ? ("tree" as const) : ("blob" as const) };
    });
}
