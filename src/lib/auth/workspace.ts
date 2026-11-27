import { ObjectId } from "mongodb";
import { getMembershipsCollection, getWorkspacesCollection } from "@/lib/db/collections";
import type { Membership, MembershipRole, SessionUser, Workspace } from "@/types";

export type WorkspaceAccess =
  | { ok: true; workspace: Workspace; membership: Membership }
  | { ok: false; status: 401 | 403 | 404 };

/**
 * The one gate for tenant data. Membership is read from the database on every
 * call (not the session) so removing a member takes effect immediately.
 * Non-members get 404, not 403, so workspace ids don't leak existence.
 */
export async function authorizeWorkspace(
  user: SessionUser | null,
  workspaceId: string,
  opts: { role?: MembershipRole } = {}
): Promise<WorkspaceAccess> {
  if (!user) return { ok: false, status: 401 };
  if (!ObjectId.isValid(workspaceId)) return { ok: false, status: 404 };
  const id = new ObjectId(workspaceId);

  const membership = await (await getMembershipsCollection()).findOne({
    workspaceId: id,
    githubId: user.githubId,
    status: "active",
  });
  if (!membership) return { ok: false, status: 404 };

  const workspace = await (await getWorkspacesCollection()).findOne({ _id: id });
  if (!workspace) return { ok: false, status: 404 };

  if (opts.role === "owner" && membership.role !== "owner") return { ok: false, status: 403 };
  return { ok: true, workspace, membership };
}

export async function listMyWorkspaces(
  githubId: number
): Promise<Array<{ workspace: Workspace; role: MembershipRole }>> {
  const memberships = await (await getMembershipsCollection())
    .find({ githubId, status: "active" })
    .toArray();
  if (memberships.length === 0) return [];
  const workspaces = await (await getWorkspacesCollection())
    .find({ _id: { $in: memberships.map((m) => m.workspaceId) } })
    .sort({ githubAccountLogin: 1 })
    .toArray();
  return workspaces.map((workspace) => ({
    workspace,
    role: memberships.find((m) => m.workspaceId.equals(workspace._id))!.role,
  }));
}
