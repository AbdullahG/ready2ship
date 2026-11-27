import { ObjectId } from "mongodb";
import { getMembershipsCollection } from "@/lib/db/collections";
import { getInstallationOctokit } from "@/lib/github/app";
import type { Membership, MembershipRole, Workspace } from "@/types";

export type MemberResult = { ok: true } | { ok: false; status: 404 | 409 | 422; error: string };

const GITHUB_LOGIN = /^[a-z\d](?:[a-z\d-]{0,38})$/i;
const LAST_OWNER = "A workspace needs at least one owner.";

export function toPublicMember(m: Membership) {
  return { id: m._id.toString(), login: m.githubLogin, role: m.role, status: m.status };
}

export async function listMembers(workspace: Workspace): Promise<Membership[]> {
  return (await getMembershipsCollection())
    .find({ workspaceId: workspace._id })
    .sort({ role: -1, githubLogin: 1 })
    .toArray();
}

/**
 * Invites by GitHub username. The id is resolved now (with the workspace's
 * installation token) so the invite matches the account even if it is renamed
 * before the invitee signs in.
 */
export async function inviteMember(workspace: Workspace, rawLogin: string, invitedBy: string): Promise<MemberResult> {
  const login = rawLogin.trim().replace(/^@/, "");
  if (!GITHUB_LOGIN.test(login)) return { ok: false, status: 422, error: "Enter a valid GitHub username." };

  const memberships = await getMembershipsCollection();
  const existing = await memberships.findOne({ workspaceId: workspace._id, githubLogin: login.toLowerCase() });
  if (existing) return { ok: false, status: 409, error: `@${login} is already in this workspace.` };

  let githubUser: { id: number; login: string };
  try {
    const octokit = await getInstallationOctokit(workspace.githubInstallationId);
    githubUser = (await octokit.users.getByUsername({ username: login })).data;
  } catch (err) {
    if ((err as { status?: number }).status === 404) {
      return { ok: false, status: 422, error: `No GitHub user named @${login}.` };
    }
    throw err;
  }

  try {
    await memberships.insertOne({
      _id: new ObjectId(),
      workspaceId: workspace._id,
      githubId: githubUser.id,
      githubLogin: githubUser.login.toLowerCase(),
      role: "member",
      status: "pending",
      invitedBy,
      createdAt: new Date(),
    });
  } catch (err) {
    // Unique (workspaceId, githubLogin): a concurrent invite won.
    if ((err as { code?: number }).code === 11000) {
      return { ok: false, status: 409, error: `@${login} is already in this workspace.` };
    }
    throw err;
  }
  return { ok: true };
}

/** Called on sign-in: invites addressed to this GitHub account become active. */
export async function activatePendingInvites(githubId: number): Promise<void> {
  await (await getMembershipsCollection()).updateMany(
    { githubId, status: "pending" },
    { $set: { status: "active" } }
  );
}

async function findMember(workspace: Workspace, memberId: string): Promise<Membership | null> {
  if (!ObjectId.isValid(memberId)) return null;
  return (await getMembershipsCollection()).findOne({ _id: new ObjectId(memberId), workspaceId: workspace._id });
}

async function isLastActiveOwner(workspace: Workspace, member: Membership): Promise<boolean> {
  if (member.role !== "owner" || member.status !== "active") return false;
  return (await countActiveOwners(workspace)) <= 1;
}

async function countActiveOwners(workspace: Workspace): Promise<number> {
  return (await getMembershipsCollection()).countDocuments({
    workspaceId: workspace._id,
    role: "owner",
    status: "active",
  });
}

/** Test seam: runs between the owner precheck and the write. */
export interface OwnerChangeHooks {
  afterPrecheck?: () => Promise<void>;
}

/**
 * The precheck alone races: two owners demoting each other at once both see
 * two owners. Without transactions (single-node MongoDB), apply the change,
 * recount, and undo it if no active owner is left. Concurrent requests that
 * both undo leave both owners in place, which is the safe outcome.
 */
async function ensureOwnerRemains(workspace: Workspace, undo: () => Promise<unknown>): Promise<boolean> {
  if ((await countActiveOwners(workspace)) > 0) return true;
  await undo();
  return false;
}

/**
 * Undo of a removal. If the person was re-added in the meantime (unique
 * login per workspace), that membership becomes the owner instead.
 */
async function restoreOwner(member: Membership): Promise<void> {
  const memberships = await getMembershipsCollection();
  for (let attempt = 1; ; attempt++) {
    try {
      await memberships.insertOne(member);
      return;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        await memberships.updateOne(
          { workspaceId: member.workspaceId, githubLogin: member.githubLogin },
          { $set: { role: "owner", status: "active", githubId: member.githubId } }
        );
        return;
      }
      if (attempt >= 2) {
        console.error(`CRITICAL: workspace ${member.workspaceId} may have no owner; restoring ${member.githubLogin} failed`, err);
        throw err;
      }
    }
  }
}

export async function changeMemberRole(
  workspace: Workspace,
  memberId: string,
  role: MembershipRole,
  hooks: OwnerChangeHooks = {}
): Promise<MemberResult> {
  const member = await findMember(workspace, memberId);
  if (!member) return { ok: false, status: 404, error: "Member not found." };
  if (role === "member" && (await isLastActiveOwner(workspace, member))) {
    return { ok: false, status: 409, error: LAST_OWNER };
  }
  await hooks.afterPrecheck?.();

  const memberships = await getMembershipsCollection();
  await memberships.updateOne({ _id: member._id }, { $set: { role } });
  const kept = await ensureOwnerRemains(workspace, () =>
    memberships.updateOne({ _id: member._id }, { $set: { role: member.role } })
  );
  return kept ? { ok: true } : { ok: false, status: 409, error: LAST_OWNER };
}

export async function removeMember(
  workspace: Workspace,
  memberId: string,
  hooks: OwnerChangeHooks = {}
): Promise<MemberResult> {
  const member = await findMember(workspace, memberId);
  if (!member) return { ok: false, status: 404, error: "Member not found." };
  if (await isLastActiveOwner(workspace, member)) return { ok: false, status: 409, error: LAST_OWNER };
  await hooks.afterPrecheck?.();

  const memberships = await getMembershipsCollection();
  await memberships.deleteOne({ _id: member._id });
  const kept = await ensureOwnerRemains(workspace, () => restoreOwner(member));
  return kept ? { ok: true } : { ok: false, status: 409, error: LAST_OWNER };
}
