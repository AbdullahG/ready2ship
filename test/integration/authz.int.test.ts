import { describe, expect, it } from "vitest";
import { authorizeWorkspace, listMyWorkspaces } from "@/lib/auth/workspace";
import { makeMembership, makeWorkspace } from "./builders";
import type { SessionUser } from "@/types";

const alice: SessionUser = { id: "1", githubId: 1, githubUsername: "alice", avatarUrl: "" };
const bob: SessionUser = { id: "2", githubId: 2, githubUsername: "bob", avatarUrl: "" };

describe("workspace authorization", () => {
  it("I-06 rejectsAnonymousUsersWith401", async () => {
    const ws = await makeWorkspace();
    expect(await authorizeWorkspace(null, ws._id.toString())).toEqual({ ok: false, status: 401 });
  });

  it("I-06 hidesWorkspacesFromNonMembersWith404", async () => {
    const ws = await makeWorkspace();
    await makeMembership(ws, { id: 1, login: "alice" }, { role: "owner" });
    expect(await authorizeWorkspace(bob, ws._id.toString())).toEqual({ ok: false, status: 404 });
  });

  it("I-06 treatsMalformedIdsAsNotFound", async () => {
    expect(await authorizeWorkspace(alice, "not-an-id")).toEqual({ ok: false, status: 404 });
  });

  it("I-06 pendingInviteDoesNotGrantAccess", async () => {
    const ws = await makeWorkspace();
    await makeMembership(ws, { id: 2, login: "bob" }, { status: "pending" });
    expect(await authorizeWorkspace(bob, ws._id.toString())).toEqual({ ok: false, status: 404 });
  });

  it("I-06 membershipMatchesByGithubIdNotLogin", async () => {
    const ws = await makeWorkspace();
    // Same login, different account (login was renamed and re-registered).
    await makeMembership(ws, { id: 99, login: "bob" });
    expect(await authorizeWorkspace(bob, ws._id.toString())).toEqual({ ok: false, status: 404 });
  });

  it("I-06 activeMemberIsAllowedButNotForOwnerOnlyActions", async () => {
    const ws = await makeWorkspace();
    await makeMembership(ws, { id: 2, login: "bob" });

    const read = await authorizeWorkspace(bob, ws._id.toString());
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.workspace._id.equals(ws._id)).toBe(true);
      expect(read.membership.role).toBe("member");
    }
    expect(await authorizeWorkspace(bob, ws._id.toString(), { role: "owner" })).toEqual({ ok: false, status: 403 });
  });

  it("I-06 ownerIsAllowedOwnerOnlyActions", async () => {
    const ws = await makeWorkspace();
    await makeMembership(ws, { id: 1, login: "alice" }, { role: "owner" });
    expect((await authorizeWorkspace(alice, ws._id.toString(), { role: "owner" })).ok).toBe(true);
  });

  it("I-06 listsOnlyWorkspacesWithActiveMemberships", async () => {
    const mine = await makeWorkspace({ githubAccountLogin: "mine" });
    const pending = await makeWorkspace({ githubAccountLogin: "pending" });
    await makeWorkspace({ githubAccountLogin: "foreign" });
    await makeMembership(mine, { id: 1, login: "alice" }, { role: "owner" });
    await makeMembership(pending, { id: 1, login: "alice" }, { status: "pending" });

    const list = await listMyWorkspaces(1);
    expect(list.map((w) => [w.workspace.githubAccountLogin, w.role])).toEqual([["mine", "owner"]]);
  });
});
