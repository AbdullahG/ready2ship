import { describe, expect, it } from "vitest";
import {
  activatePendingInvites,
  changeMemberRole,
  inviteMember,
  listMembers,
  removeMember,
} from "@/lib/workspaces/members";
import { authorizeWorkspace } from "@/lib/auth/workspace";
import { getMembershipsCollection } from "@/lib/db/collections";
import { testEnv } from "./env";
import { makeMembership, makeWorkspace } from "./builders";

async function workspaceWithOwner() {
  const ws = await makeWorkspace();
  testEnv.github.addInstallation({ id: ws.githubInstallationId, accountLogin: ws.githubAccountLogin });
  const owner = await makeMembership(ws, { id: 1, login: "alice" }, { role: "owner" });
  return { ws, owner };
}

describe("workspace members", () => {
  it("I-09 invitingResolvesTheGitHubIdAndCreatesAPendingMember", async () => {
    const { ws } = await workspaceWithOwner();
    const bob = testEnv.github.addUser("Bob");

    const result = await inviteMember(ws, "@Bob ", "alice");

    expect(result.ok).toBe(true);
    const m = await (await getMembershipsCollection()).findOne({ githubLogin: "bob" });
    expect(m).toMatchObject({ githubId: bob.id, status: "pending", role: "member", invitedBy: "alice" });
    // Resolved with the installation token, not a user token.
    const lookup = testEnv.github.http.requests.find((r) => r.path === "/api/users/Bob");
    expect(lookup?.headers.authorization).toBe(`token inst-${ws.githubInstallationId}`);
  });

  it.each([
    ["unknown user", "ghost", 422, /No GitHub user/],
    ["invalid login", "bad login!", 422, /valid GitHub username/],
    ["empty", "  ", 422, /valid GitHub username/],
  ])("I-09 rejects %s", async (_label, login, status, message) => {
    const { ws } = await workspaceWithOwner();
    const result = await inviteMember(ws, login, "alice");
    expect(result).toEqual({ ok: false, status, error: expect.stringMatching(message) });
  });

  it("I-09 rejectsADuplicateInviteCaseInsensitively", async () => {
    const { ws } = await workspaceWithOwner();
    testEnv.github.addUser("bob");
    await inviteMember(ws, "bob", "alice");
    expect(await inviteMember(ws, "BOB", "alice")).toEqual({ ok: false, status: 409, error: expect.stringMatching(/already/) });
    expect(await inviteMember(ws, "alice", "alice")).toEqual({ ok: false, status: 409, error: expect.stringMatching(/already/) });
  });

  it("I-07 loginActivatesPendingInvitesForThatGithubIdOnly", async () => {
    const { ws } = await workspaceWithOwner();
    const bob = testEnv.github.addUser("bob");
    testEnv.github.addUser("carol");
    await inviteMember(ws, "bob", "alice");
    await inviteMember(ws, "carol", "alice");
    const bobSession = { id: String(bob.id), githubId: bob.id, githubUsername: "bob", avatarUrl: "" };

    expect((await authorizeWorkspace(bobSession, ws._id.toString())).ok).toBe(false);
    await activatePendingInvites(bob.id);
    expect((await authorizeWorkspace(bobSession, ws._id.toString())).ok).toBe(true);

    const carol = await (await getMembershipsCollection()).findOne({ githubLogin: "carol" });
    expect(carol!.status).toBe("pending");
  });

  it("I-08 theLastOwnerCannotBeDemotedOrRemoved", async () => {
    const { ws, owner } = await workspaceWithOwner();
    // A pending owner invite doesn't count as a second owner.
    await makeMembership(ws, { id: 3, login: "pendingowner" }, { role: "owner", status: "pending" });

    expect(await changeMemberRole(ws, owner._id.toString(), "member")).toEqual({
      ok: false,
      status: 409,
      error: "A workspace needs at least one owner.",
    });
    expect(await removeMember(ws, owner._id.toString())).toEqual({
      ok: false,
      status: 409,
      error: "A workspace needs at least one owner.",
    });
    expect((await (await getMembershipsCollection()).findOne({ _id: owner._id }))!.role).toBe("owner");
  });

  it("I-08 withASecondOwnerEitherCanStepDownAndMembersCanBeRemoved", async () => {
    const { ws, owner } = await workspaceWithOwner();
    const bob = await makeMembership(ws, { id: 2, login: "bob" });

    expect((await changeMemberRole(ws, bob._id.toString(), "owner")).ok).toBe(true);
    expect((await changeMemberRole(ws, owner._id.toString(), "member")).ok).toBe(true);
    expect((await removeMember(ws, owner._id.toString())).ok).toBe(true);

    const left = await listMembers(ws);
    expect(left.map((m) => [m.githubLogin, m.role])).toEqual([["bob", "owner"]]);
  });

  it("I-08 membersOfAnotherWorkspaceCannotBeTargeted", async () => {
    const { ws } = await workspaceWithOwner();
    const other = await makeWorkspace();
    const stranger = await makeMembership(other, { id: 9, login: "stranger" });

    expect(await removeMember(ws, stranger._id.toString())).toEqual({ ok: false, status: 404, error: "Member not found." });
    expect(await changeMemberRole(ws, "nope", "owner")).toEqual({ ok: false, status: 404, error: "Member not found." });
    expect(await (await getMembershipsCollection()).countDocuments({ _id: stranger._id })).toBe(1);
  });
});

describe("last owner under concurrency", () => {
  async function twoOwners() {
    const ws = await makeWorkspace();
    const alice = await makeMembership(ws, { id: 1, login: "alice" }, { role: "owner" });
    const bob = await makeMembership(ws, { id: 2, login: "bob" }, { role: "owner" });
    return { ws, alice, bob };
  }
  const activeOwners = async (ws: { _id: unknown }) =>
    (await getMembershipsCollection()).countDocuments({ workspaceId: ws._id as never, role: "owner", status: "active" });

  it("I-21 concurrentDemotionsAndRemovalsAlwaysLeaveAnOwner", async () => {
    for (let i = 0; i < 25; i++) {
      await (await getMembershipsCollection()).deleteMany({});
      const { ws, alice, bob } = await twoOwners();
      const ops =
        i % 2 === 0
          ? [changeMemberRole(ws, alice._id.toString(), "member"), changeMemberRole(ws, bob._id.toString(), "member")]
          : [removeMember(ws, alice._id.toString()), changeMemberRole(ws, bob._id.toString(), "member")];
      const results = await Promise.all(ops);
      expect(await activeOwners(ws), `run ${i}: ${JSON.stringify(results)}`).toBeGreaterThanOrEqual(1);
    }
  });

  it("I-22 aDemotionThatWouldLeaveNoOwnerIsRolledBack", async () => {
    const { ws, alice, bob } = await twoOwners();
    // The other owner steps down between our check and our write.
    const result = await changeMemberRole(ws, alice._id.toString(), "member", {
      afterPrecheck: async () => {
        await (await getMembershipsCollection()).updateOne({ _id: bob._id }, { $set: { role: "member" } });
      },
    });
    expect(result).toEqual({ ok: false, status: 409, error: "A workspace needs at least one owner." });
    expect((await (await getMembershipsCollection()).findOne({ _id: alice._id }))!.role).toBe("owner");
  });

  it("I-22 aRemovalThatWouldLeaveNoOwnerIsRolledBack", async () => {
    const { ws, alice, bob } = await twoOwners();
    const result = await removeMember(ws, alice._id.toString(), {
      afterPrecheck: async () => {
        await (await getMembershipsCollection()).updateOne({ _id: bob._id }, { $set: { role: "member" } });
      },
    });
    expect(result).toEqual({ ok: false, status: 409, error: "A workspace needs at least one owner." });
    expect(await (await getMembershipsCollection()).findOne({ _id: alice._id })).toMatchObject({ role: "owner", status: "active" });
  });
});

describe("last owner undo edge cases", () => {
  it("I-23 ifTheRemovedOwnerWasReAddedMeanwhileTheUndoPromotesThatMembership", async () => {
    const ws = await makeWorkspace();
    const alice = await makeMembership(ws, { id: 1, login: "alice" }, { role: "owner" });
    const bob = await makeMembership(ws, { id: 2, login: "bob" }, { role: "owner" });

    const result = await removeMember(ws, alice._id.toString(), {
      afterPrecheck: async () => {
        const memberships = await getMembershipsCollection();
        await memberships.updateOne({ _id: bob._id }, { $set: { role: "member" } });
        // alice is removed and immediately re-invited by someone else
        await memberships.deleteOne({ _id: alice._id });
        await makeMembership(ws, { id: 1, login: "alice" }, { role: "member", status: "pending" });
      },
    });

    expect(result).toEqual({ ok: false, status: 409, error: "A workspace needs at least one owner." });
    const owners = await (await getMembershipsCollection()).find({ workspaceId: ws._id, role: "owner", status: "active" }).toArray();
    expect(owners.map((o) => o.githubLogin)).toEqual(["alice"]);
  });
});
