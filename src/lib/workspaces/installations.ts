import { ObjectId } from "mongodb";
import {
  getFindingsCollection,
  getMembershipsCollection,
  getPullsCollection,
  getWorkspacesCollection,
} from "@/lib/db/collections";
import { config } from "@/lib/config";
import type { Workspace, WorkspaceStatus } from "@/types";

export interface InstallationAccount {
  id: number;
  login: string;
  type: string;
}

export function isAccountAllowed(login: string): boolean {
  const { allowedAccounts } = config();
  return allowedAccounts.length === 0 || allowedAccounts.includes(login.toLowerCase());
}

/**
 * Creates the workspace for an installation (if new) and makes `owner` an
 * active owner. Called from both the installation webhook and the Setup URL
 * redirect; they can arrive in either order, so this is idempotent.
 * Returns null when the account is not on ALLOWED_GITHUB_ACCOUNTS.
 */
export async function upsertWorkspaceFromInstallation(input: {
  installationId: number;
  account: InstallationAccount;
  owner: { id: number; login: string };
}): Promise<Workspace | null> {
  if (!isAccountAllowed(input.account.login)) {
    console.warn(`Installation rejected (not in ALLOWED_GITHUB_ACCOUNTS): ${input.account.login}`);
    return null;
  }

  const workspaces = await getWorkspacesCollection();
  const workspace = await workspaces.findOneAndUpdate(
    { githubInstallationId: input.installationId },
    {
      $set: {
        githubAccountId: input.account.id,
        githubAccountLogin: input.account.login,
        githubAccountType: input.account.type === "User" ? "User" : "Organization",
      },
      $setOnInsert: {
        githubInstallationId: input.installationId,
        status: "active" as WorkspaceStatus,
        ai: {
          provider: "gemini" as const,
          encryptedKey: null,
          keyLast4: null,
          keyStatus: "missing" as const,
          keyUpdatedAt: null,
          keyUpdatedBy: null,
        },
        onboardingCompletedAt: null,
        firstReviewAt: null,
        createdAt: new Date(),
      },
    },
    { upsert: true, returnDocument: "after" }
  );
  if (!workspace) throw new Error("Workspace upsert returned nothing");

  // Match by GitHub id first so a renamed account keeps a single membership.
  const memberships = await getMembershipsCollection();
  const login = input.owner.login.toLowerCase();
  const existing =
    (await memberships.findOne({ workspaceId: workspace._id, githubId: input.owner.id })) ??
    (await memberships.findOne({ workspaceId: workspace._id, githubLogin: login }));
  if (existing) {
    await memberships.updateOne(
      { _id: existing._id },
      { $set: { githubId: input.owner.id, githubLogin: login, role: "owner", status: "active" } }
    );
  } else {
    await memberships.updateOne(
      { workspaceId: workspace._id, githubLogin: login },
      {
        $set: { githubId: input.owner.id, role: "owner", status: "active" },
        $setOnInsert: { invitedBy: input.owner.login, createdAt: new Date() },
      },
      { upsert: true }
    );
  }

  return workspace;
}

export async function getWorkspaceByInstallation(installationId: number): Promise<Workspace | null> {
  return (await getWorkspacesCollection()).findOne({ githubInstallationId: installationId });
}

/** Uninstall = the customer revoked access: drop their key and all their data. */
export async function deleteWorkspaceByInstallation(installationId: number): Promise<void> {
  const workspace = await getWorkspaceByInstallation(installationId);
  if (!workspace) return;
  const workspaceId: ObjectId = workspace._id;
  await (await getFindingsCollection()).deleteMany({ workspaceId });
  await (await getPullsCollection()).deleteMany({ workspaceId });
  await (await getMembershipsCollection()).deleteMany({ workspaceId });
  await (await getWorkspacesCollection()).deleteOne({ _id: workspaceId });
}

export async function setWorkspaceStatus(installationId: number, status: WorkspaceStatus): Promise<void> {
  await (await getWorkspacesCollection()).updateOne(
    { githubInstallationId: installationId },
    { $set: { status } }
  );
}
