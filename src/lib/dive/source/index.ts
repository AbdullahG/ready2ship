import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getInstallationToken } from "@/lib/github/app";
import { getRepoInfo } from "@/lib/github/api";
import { splitRepo } from "@/lib/github/pipeline/shared";
import { createApiSource } from "./api";
import { createCloneSource } from "./clone";
import type { RepoSource } from "./types";

export type { RepoSource, FileSlice, GrepHit } from "./types";
export { SourceError, MAX_FILE_BYTES } from "./types";

/** Repos larger than this are read through the API: on Cloud Run /tmp is RAM. */
export const MAX_CLONE_MB = 500;
const CLONES_DIR = join(tmpdir(), "r2s-dive");

/** A checkout of the PR head when possible, else the API (no grep). */
export async function createRepoSource(input: {
  installationId: number;
  repoFullName: string;
  prNumber: number;
  headSha: string;
  jobId: string;
}): Promise<RepoSource> {
  const { installationId, repoFullName, prNumber, headSha, jobId } = input;
  const api = () => createApiSource({ installationId, repoFullName, headSha });
  const fallback = (reason: string) => {
    console.warn(JSON.stringify({ msg: "dive.source_fallback", repo: repoFullName, pr: prNumber, reason }));
    return api();
  };

  const { owner, repo } = splitRepo(repoFullName);
  const { sizeKb } = await getRepoInfo(installationId, owner, repo);
  if (sizeKb > MAX_CLONE_MB * 1024) return fallback(`repository is ${Math.round(sizeKb / 1024)} MB, over ${MAX_CLONE_MB} MB`);

  try {
    const token = await getInstallationToken(installationId);
    // Unique even if two runs share a job id (retries, several processes on one /tmp).
    await mkdir(CLONES_DIR, { recursive: true });
    const dir = await mkdtemp(join(CLONES_DIR, `${jobId}-`));
    return await createCloneSource({ dir, repoFullName, prNumber, token });
  } catch (err) {
    // git's stderr says why (it never contains the token: that travels in env, not the URL).
    const stderr = String((err as { stderr?: string }).stderr ?? "").trim().split("\n").slice(-2).join(" | ");
    return fallback(`clone failed: ${(err as Error).message.split("\n")[0]}${stderr ? ` (${stderr})` : ""}`);
  }
}

/** A checkout untouched for this long belongs to no running review (leases are minutes). */
const STALE_CHECKOUT_MS = 60 * 60_000;

/** Removes checkouts left behind by a process that died mid-review, not ones another process is using. */
export async function removeStaleCheckouts(now = Date.now()): Promise<void> {
  const names = await readdir(CLONES_DIR).catch(() => [] as string[]);
  for (const name of names) {
    const dir = join(CLONES_DIR, name);
    const { mtimeMs } = await stat(dir).catch(() => ({ mtimeMs: now }));
    if (now - mtimeMs > STALE_CHECKOUT_MS) await rm(dir, { recursive: true, force: true });
  }
}
