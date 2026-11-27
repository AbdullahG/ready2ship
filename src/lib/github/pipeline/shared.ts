import { getWorkspacesCollection } from "@/lib/db/collections";
import { getWorkspaceByInstallation } from "@/lib/workspaces/installations";
import { getProviderForWorkspace, type AIProvider } from "@/lib/ai";
import { InvalidKeyError, MissingKeyError } from "@/lib/ai/errors";
import { config } from "@/lib/config";
import type { Workspace } from "@/types";

/** Events for unknown (uninstalled, not allowed) or suspended installations are dropped. */
export async function activeWorkspace(installationId: number): Promise<Workspace | null> {
  const workspace = await getWorkspaceByInstallation(installationId);
  if (!workspace || workspace.status !== "active") {
    console.warn(`Ignoring event for inactive installation ${installationId}`);
    return null;
  }
  return workspace;
}

export async function markKeyInvalid(workspace: Workspace): Promise<void> {
  await (await getWorkspacesCollection()).updateOne(
    { _id: workspace._id },
    { $set: { "ai.keyStatus": "invalid" } }
  );
}

/** Provider for a comment-triggered call; null (logged) when the key is missing. */
export function providerOrNull(workspace: Workspace): AIProvider | null {
  try {
    return getProviderForWorkspace(workspace);
  } catch (err) {
    if (err instanceof MissingKeyError) {
      console.warn(`Workspace ${workspace._id} has no AI key, skipping AI call`);
      return null;
    }
    throw err;
  }
}

/** Runs an AI call for a comment; a rejected key marks the workspace and yields null. */
export async function answerOrMarkInvalid(
  workspace: Workspace,
  ask: (p: AIProvider) => Promise<string>
): Promise<string | null> {
  const provider = providerOrNull(workspace);
  if (!provider) return null;
  try {
    return await ask(provider);
  } catch (err) {
    if (err instanceof InvalidKeyError) {
      await markKeyInvalid(workspace);
      return null;
    }
    throw err;
  }
}

export function isOwnComment(login: string): boolean {
  const { appSlug } = config().github;
  return login === appSlug || login === `${appSlug}[bot]`;
}

export function splitRepo(fullName: string): { owner: string; repo: string } {
  const [owner, repo] = fullName.split("/");
  return { owner, repo };
}
