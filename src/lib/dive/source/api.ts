import { getRepoTree, getFileTextOrNull } from "@/lib/github/api";
import { splitRepo } from "@/lib/github/pipeline/shared";
import { MAX_DIR_ENTRIES, SourceError, sliceLines, type RepoSource } from "./types";

/** Reads the head commit through the REST API: no checkout, no grep. */
export function createApiSource(input: { installationId: number; repoFullName: string; headSha: string }): RepoSource {
  const { installationId, repoFullName, headSha } = input;
  const { owner, repo } = splitRepo(repoFullName);
  let tree: Promise<Array<{ path: string; type: "blob" | "tree" }>> | null = null;

  const clean = (path: string) => {
    const p = path.replace(/^\.\//, "").replace(/\/+$/, "");
    if (p.startsWith("/") || p.split("/").includes("..")) throw new SourceError(`${path} is outside the repository`);
    return p;
  };

  return {
    kind: "api",
    async listDir(path) {
      const dir = clean(path);
      tree ??= getRepoTree(installationId, owner, repo, headSha);
      const prefix = dir ? `${dir}/` : "";
      const entries = (await tree)
        .filter((e) => e.path.startsWith(prefix) && !e.path.slice(prefix.length).includes("/"))
        .map((e) => e.path.slice(prefix.length) + (e.type === "tree" ? "/" : ""));
      if (dir && entries.length === 0) throw new SourceError(`${path}: not a directory`);
      return entries.sort().slice(0, MAX_DIR_ENTRIES);
    },
    async readFile(path, start, end) {
      const text = await getFileTextOrNull(installationId, owner, repo, clean(path), headSha);
      if (text === null) throw new SourceError(`${path}: not found`);
      return sliceLines(text, path, start, end);
    },
    async dispose() {},
  };
}
