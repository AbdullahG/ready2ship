import { Collection, Db } from "mongodb";
import { getClientPromise } from "./client";
import { config } from "@/lib/config";
import type {
  User,
  Workspace,
  Membership,
  PullRequest,
  ReviewFinding,
  Job,
} from "@/types";

let db: Db | null = null;

async function getDb(): Promise<Db> {
  if (!db) {
    const client = await getClientPromise();
    db = client.db(config().mongodb.dbName);
  }
  return db;
}

export async function getUsersCollection(): Promise<Collection<User>> {
  return (await getDb()).collection<User>("users");
}

export async function getWorkspacesCollection(): Promise<Collection<Workspace>> {
  return (await getDb()).collection<Workspace>("workspaces");
}

export async function getMembershipsCollection(): Promise<Collection<Membership>> {
  return (await getDb()).collection<Membership>("memberships");
}

export async function getPullsCollection(): Promise<Collection<PullRequest>> {
  return (await getDb()).collection<PullRequest>("pull_requests");
}

export async function getFindingsCollection(): Promise<Collection<ReviewFinding>> {
  return (await getDb()).collection<ReviewFinding>("review_findings");
}

export async function getJobsCollection(): Promise<Collection<Job>> {
  return (await getDb()).collection<Job>("jobs");
}

export async function ensureIndexes(): Promise<void> {
  const database = await getDb();

  await database.collection("users").createIndex({ githubId: 1 }, { unique: true });

  await database
    .collection("workspaces")
    .createIndex({ githubInstallationId: 1 }, { unique: true });

  await database
    .collection("memberships")
    .createIndex({ workspaceId: 1, githubLogin: 1 }, { unique: true });
  await database.collection("memberships").createIndex({ githubId: 1, status: 1 });

  await database
    .collection("pull_requests")
    .createIndex({ workspaceId: 1, repoFullName: 1, githubPrNumber: 1 }, { unique: true });
  await database
    .collection("pull_requests")
    .createIndex({ workspaceId: 1, status: 1, updatedAt: -1 });

  await database.collection("review_findings").createIndex({ workspaceId: 1, prId: 1, status: 1 });
  await database.collection("review_findings").createIndex({ githubCommentId: 1 });

  const jobs = database.collection("jobs");
  await jobs.createIndex(
    { deliveryId: 1 },
    { unique: true, partialFilterExpression: { deliveryId: { $type: "string" } } }
  );
  await jobs.createIndex({ status: 1, runAfter: 1, createdAt: 1 });
  // At most one running job per pull request (see claimNext).
  await jobs.createIndex(
    { prKey: 1 },
    { unique: true, name: "one_running_per_pr", partialFilterExpression: { status: "running", prKey: { $type: "string" } } }
  );
  await jobs.createIndex({ finishedAt: 1 }, { expireAfterSeconds: 14 * 24 * 3600 });
}
