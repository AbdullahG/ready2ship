import { ObjectId } from "mongodb";
import {
  getFindingsCollection,
  getMembershipsCollection,
  getPullsCollection,
  getWorkspacesCollection,
} from "@/lib/db/collections";
import { encryptSecret } from "@/lib/crypto";
import type { Membership, PullRequest, Workspace } from "@/types";

let seq = 1;

export async function makeWorkspace(overrides: Partial<Workspace> & { aiKey?: string } = {}): Promise<Workspace> {
  const n = seq++;
  const { aiKey, ...rest } = overrides;
  const ws: Workspace = {
    _id: new ObjectId(),
    githubInstallationId: 500 + n,
    githubAccountId: 9000 + n,
    githubAccountLogin: `acct-${n}`,
    githubAccountType: "Organization",
    status: "active",
    ai: aiKey
      ? { provider: "gemini", encryptedKey: encryptSecret(aiKey), keyLast4: aiKey.slice(-4), keyStatus: "valid", keyUpdatedAt: new Date(), keyUpdatedBy: "seed" }
      : { provider: "gemini", encryptedKey: null, keyLast4: null, keyStatus: "missing", keyUpdatedAt: null, keyUpdatedBy: null },
    onboardingCompletedAt: aiKey ? new Date() : null,
    firstReviewAt: null,
    createdAt: new Date(),
    ...rest,
  };
  await (await getWorkspacesCollection()).insertOne(ws);
  return ws;
}

export async function makeMembership(
  workspace: Workspace,
  user: { id: number; login: string },
  overrides: Partial<Membership> = {}
): Promise<Membership> {
  const m: Membership = {
    _id: new ObjectId(),
    workspaceId: workspace._id,
    githubId: user.id,
    githubLogin: user.login.toLowerCase(),
    role: "member",
    status: "active",
    invitedBy: "seed",
    createdAt: new Date(),
    ...overrides,
  };
  await (await getMembershipsCollection()).insertOne(m);
  return m;
}

export async function makePull(workspace: Workspace, overrides: Partial<PullRequest> = {}): Promise<PullRequest> {
  const n = seq++;
  const pr: PullRequest = {
    _id: new ObjectId(),
    workspaceId: workspace._id,
    repoFullName: `${workspace.githubAccountLogin}/repo`,
    githubPrNumber: n,
    githubPrId: n * 1000,
    githubInstallationId: workspace.githubInstallationId,
    title: `PR ${n}`,
    author: "someone",
    authorAvatarUrl: "",
    headSha: "abc",
    headBranch: "feature",
    headRepoFullName: `${workspace.githubAccountLogin}/repo`,
    baseBranch: "main",
    githubPrUrl: `https://github.example/pr/${n}`,
    status: "reviewed",
    summary: "",
    reviewStats: { blockers: 0, minors: 0, improvements: 0, resolvedBlockers: 0 },
    summaryCommentId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  await (await getPullsCollection()).insertOne(pr);
  await (await getFindingsCollection()).insertOne({
    _id: new ObjectId(),
    workspaceId: workspace._id,
    prId: pr._id,
    severity: "minor",
    file: "a.ts",
    startLine: 1,
    endLine: 1,
    description: "seed finding",
    suggestion: "",
    githubCommentId: null,
    status: "open",
    createdAt: new Date(),
  });
  return pr;
}
