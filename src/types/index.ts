import { ObjectId } from "mongodb";
import type { EncryptedSecret } from "@/lib/crypto";
import type { ReviewMode } from "@/lib/repo-config";

export interface User {
  _id: ObjectId;
  githubId: number;
  githubUsername: string;
  encryptedAccessToken: EncryptedSecret;
  avatarUrl: string;
  createdAt: Date;
}

export type WorkspaceStatus = "active" | "suspended";
export type AIKeyStatus = "missing" | "valid" | "invalid";

/** One GitHub App installation (an org or a personal account). */
export interface Workspace {
  _id: ObjectId;
  githubInstallationId: number;
  githubAccountId: number;
  githubAccountLogin: string;
  githubAccountType: "User" | "Organization";
  status: WorkspaceStatus;
  ai: {
    provider: "gemini";
    encryptedKey: EncryptedSecret | null;
    keyLast4: string | null;
    keyStatus: AIKeyStatus;
    keyUpdatedAt: Date | null;
    keyUpdatedBy: string | null;
  };
  onboardingCompletedAt: Date | null;
  firstReviewAt: Date | null;
  createdAt: Date;
}

export type MembershipRole = "owner" | "member";
export type MembershipStatus = "pending" | "active";

export interface Membership {
  _id: ObjectId;
  workspaceId: ObjectId;
  /** Null until the invitee first signs in (or resolved at invite time). */
  githubId: number | null;
  /** Lowercased. */
  githubLogin: string;
  role: MembershipRole;
  status: MembershipStatus;
  invitedBy: string;
  createdAt: Date;
}

export type PRStatus =
  | "pending"
  | "needs_setup"
  | "reviewing"
  | "reviewed"
  | "approved"
  | "closed"
  /** The review stopped on purpose: invalid .ready2ship.yml, Dive budget, or a failure Dive won't work around. */
  | "cancelled";

/** What the latest review of a PR ran as and what it cost. */
export interface LastReview {
  mode: ReviewMode;
  trigger: "auto" | "comment";
  configSource: "file" | "default";
  configWarnings: string[];
  usage: ReviewUsage | null;
  cancelledReason: string | null;
  finishedAt: Date;
}

export interface ReviewUsage {
  inputTokens: number;
  outputTokens: number;
  /** Dive only. */
  toolCalls?: number;
  filesRead?: number;
  droppedByVerification?: number;
  source?: "clone" | "api";
}

export interface PullRequest {
  _id: ObjectId;
  workspaceId: ObjectId;
  repoFullName: string;
  githubPrNumber: number;
  githubPrId: number;
  githubInstallationId: number;
  title: string;
  author: string;
  authorAvatarUrl: string;
  headSha: string;
  headBranch: string;
  /** owner/repo the head branch lives in; differs from repoFullName for fork PRs. */
  headRepoFullName: string | null;
  baseBranch: string;
  githubPrUrl: string;
  status: PRStatus;
  summary: string;
  reviewStats: {
    blockers: number;
    minors: number;
    improvements: number;
    resolvedBlockers: number;
  };
  summaryCommentId: number | null;
  /** Absent on PRs reviewed before review modes existed. */
  lastReview?: LastReview;
  createdAt: Date;
  updatedAt: Date;
}

export type FindingSeverity = "blocker" | "minor" | "improvement";
export type FindingStatus = "open" | "fixed" | "resolved";

export interface ReviewFinding {
  _id: ObjectId;
  workspaceId: ObjectId;
  prId: ObjectId;
  severity: FindingSeverity;
  file: string;
  startLine: number;
  endLine: number;
  description: string;
  suggestion: string;
  fix?: {
    original: string;
    replacement: string;
  };
  githubCommentId: number | null;
  status: FindingStatus;
  /** Which review produced it; absent on findings from before review modes. */
  reviewMode?: ReviewMode;
  createdAt: Date;
}

export interface SessionUser {
  id: string;
  githubId: number;
  githubUsername: string;
  avatarUrl: string;
}

export interface ReviewResult {
  summary: string;
  findings: Array<{
    severity: FindingSeverity;
    file: string;
    startLine: number;
    endLine: number;
    description: string;
    suggestion: string;
    fix?: {
      original: string;
      replacement: string;
    };
  }>;
}

export type JobKind = "review" | "comment" | "thread" | "closed" | "dive" | "retry";
export type JobStatus = "pending" | "running" | "done" | "failed" | "superseded";

/** A webhook event waiting to be (or being) processed; see src/lib/jobs. */
export interface Job {
  _id: ObjectId;
  /** X-GitHub-Delivery: a redelivered webhook maps to the same job. */
  deliveryId: string | null;
  event: string;
  kind: JobKind;
  payload: unknown;
  /** `${installationId}:${owner/repo}#${number}`; jobs of one PR run one at a time. */
  prKey: string | null;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  runAfter: Date;
  lockedUntil: Date | null;
  progress: { reviewSubmitted?: boolean; replied?: boolean };
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}
