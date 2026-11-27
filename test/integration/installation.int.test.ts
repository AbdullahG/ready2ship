import { describe, expect, it } from "vitest";
import { handleInstallation } from "@/lib/github/pipeline";
import { upsertWorkspaceFromInstallation } from "@/lib/workspaces/installations";
import {
  getFindingsCollection,
  getMembershipsCollection,
  getPullsCollection,
  getWorkspacesCollection,
} from "@/lib/db/collections";
import { resetConfigForTests } from "@/lib/config";
import { makeMembership, makePull, makeWorkspace } from "./builders";

function installationEvent(action: string, id = 77, login = "Acme", sender = { id: 1, login: "Alice" }) {
  return {
    action,
    installation: { id, account: { id: 700, login, type: "Organization" } },
    sender,
  };
}

describe("installation lifecycle", () => {
  it("I-02 createdEventCreatesAnActiveWorkspaceWithTheSenderAsOwner", async () => {
    await handleInstallation(installationEvent("created"));

    const ws = await (await getWorkspacesCollection()).findOne({ githubInstallationId: 77 });
    expect(ws).toMatchObject({
      githubAccountLogin: "Acme",
      githubAccountType: "Organization",
      status: "active",
      ai: { keyStatus: "missing", encryptedKey: null },
    });
    const members = await (await getMembershipsCollection()).find({ workspaceId: ws!._id }).toArray();
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ githubId: 1, githubLogin: "alice", role: "owner", status: "active" });
  });

  it("I-02 webhookAndSetupUrlTogetherStayIdempotent", async () => {
    const account = { id: 700, login: "Acme", type: "Organization" as const };
    await upsertWorkspaceFromInstallation({ installationId: 77, account, owner: { id: 1, login: "Alice" } });
    await handleInstallation(installationEvent("created"));
    await upsertWorkspaceFromInstallation({ installationId: 77, account, owner: { id: 1, login: "Alice" } });

    expect(await (await getWorkspacesCollection()).countDocuments({})).toBe(1);
    expect(await (await getMembershipsCollection()).countDocuments({})).toBe(1);
  });

  it("I-02 reinstallingKeepsTheExistingKeyAndPromotesAPendingInviteeWhoInstalls", async () => {
    const ws = await makeWorkspace({ githubInstallationId: 77, aiKey: "AIza-keep-1234" });
    await makeMembership(ws, { id: 5, login: "bob" }, { status: "pending", githubId: null });

    await upsertWorkspaceFromInstallation({
      installationId: 77,
      account: { id: 700, login: "Acme", type: "Organization" },
      owner: { id: 5, login: "Bob" },
    });

    const after = await (await getWorkspacesCollection()).findOne({ _id: ws._id });
    expect(after!.ai.keyLast4).toBe("1234");
    const bob = await (await getMembershipsCollection()).findOne({ githubLogin: "bob" });
    expect(bob).toMatchObject({ role: "owner", status: "active", githubId: 5 });
  });

  it("I-02 aRenamedInstallerKeepsOneMembershipMatchedByGithubId", async () => {
    const ws = await makeWorkspace({ githubInstallationId: 77 });
    await makeMembership(ws, { id: 1, login: "alice" }, { role: "member" });

    await handleInstallation(installationEvent("created", 77, "Acme", { id: 1, login: "Alice-Renamed" }));

    const rows = await (await getMembershipsCollection()).find({ workspaceId: ws._id }).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ githubId: 1, githubLogin: "alice-renamed", role: "owner" });
  });

  it("I-03 deletedEventRemovesTheWorkspaceAndAllItsData", async () => {
    const ws = await makeWorkspace({ githubInstallationId: 77, aiKey: "AIza-gone-0000" });
    const other = await makeWorkspace();
    await makeMembership(ws, { id: 1, login: "alice" }, { role: "owner" });
    await makeMembership(other, { id: 1, login: "alice" }, { role: "owner" });
    await makePull(ws);
    await makePull(other);

    await handleInstallation(installationEvent("deleted"));

    expect(await (await getWorkspacesCollection()).countDocuments({ _id: ws._id })).toBe(0);
    expect(await (await getMembershipsCollection()).countDocuments({ workspaceId: ws._id })).toBe(0);
    expect(await (await getPullsCollection()).countDocuments({ workspaceId: ws._id })).toBe(0);
    expect(await (await getFindingsCollection()).countDocuments({ workspaceId: ws._id })).toBe(0);
    // The other tenant is untouched.
    expect(await (await getPullsCollection()).countDocuments({ workspaceId: other._id })).toBe(1);
    expect(await (await getFindingsCollection()).countDocuments({ workspaceId: other._id })).toBe(1);
    expect(await (await getMembershipsCollection()).countDocuments({ workspaceId: other._id })).toBe(1);
  });

  it("I-04 suspendAndUnsuspendToggleTheWorkspaceStatus", async () => {
    await handleInstallation(installationEvent("created"));
    await handleInstallation(installationEvent("suspend"));
    expect((await (await getWorkspacesCollection()).findOne({ githubInstallationId: 77 }))!.status).toBe("suspended");
    await handleInstallation(installationEvent("unsuspend"));
    expect((await (await getWorkspacesCollection()).findOne({ githubInstallationId: 77 }))!.status).toBe("active");
  });

  it("I-05 allowListRejectsOtherAccountsAndAcceptsListedOnesCaseInsensitively", async () => {
    process.env.ALLOWED_GITHUB_ACCOUNTS = "acme";
    resetConfigForTests();
    try {
      await handleInstallation(installationEvent("created", 88, "Intruder"));
      await handleInstallation(installationEvent("created", 77, "ACME"));
      const logins = (await (await getWorkspacesCollection()).find({}).toArray()).map((w) => w.githubAccountLogin);
      expect(logins).toEqual(["ACME"]);
    } finally {
      delete process.env.ALLOWED_GITHUB_ACCOUNTS;
      resetConfigForTests();
    }
  });
});
