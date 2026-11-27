/** Read-only view of a PR's head commit for the Dive agent. Paths are repo-relative. */
export interface RepoSource {
  kind: "clone" | "api";
  /** Checkout directory (clone only). */
  root?: string;
  /** Entries of a directory; subdirectories end with "/". "" is the repo root. */
  listDir(path: string): Promise<string[]>;
  /** Lines `start`..`end` (1-based, inclusive) and the file's total line count. */
  readFile(path: string, start?: number, end?: number): Promise<FileSlice>;
  /** Extended-regex search over tracked text files; clone only. */
  grep?(pattern: string, pathGlob?: string): Promise<GrepHit[]>;
  dispose(): Promise<void>;
}

export interface FileSlice {
  lines: string[];
  startLine: number;
  totalLines: number;
}

export interface GrepHit {
  path: string;
  line: number;
  text: string;
}

export const MAX_DIR_ENTRIES = 500;
export const MAX_GREP_HITS = 100;
/** Larger files aren't read: a PR (from a fork, too) controls what is in the checkout. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

export class SourceError extends Error {}

export function sliceLines(text: string, path: string, start?: number, end?: number): FileSlice {
  if (text.includes("\u0000")) throw new SourceError(`${path} is a binary file`);
  const all = text.split("\n");
  if (all.length > 1 && all[all.length - 1] === "") all.pop();
  const from = Math.max(1, start ?? 1);
  const to = Math.min(all.length, end ?? all.length);
  return { lines: all.slice(from - 1, to), startLine: from, totalLines: all.length };
}
