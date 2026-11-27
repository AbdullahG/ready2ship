import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/webhooks/github/route";
import { getJobsCollection, getWorkspacesCollection } from "@/lib/db/collections";
import { testEnv } from "./env";
import { makeWorkspace } from "./builders";

function signed(event: string, payload: unknown, deliveryId = "delivery-1") {
  const body = JSON.stringify(payload);
  const sig = `sha256=${createHmac("sha256", process.env.GITHUB_WEBHOOK_SECRET!).update(body).digest("hex")}`;
  return new NextRequest("http://r2s.test/api/webhooks/github", {
    method: "POST",
    body,
    headers: { "x-github-event": event, "x-hub-signature-256": sig, "content-type": "application/json", "x-github-delivery": deliveryId },
  });
}

describe("webhook route", () => {
  it("I-20 installationDeletedIsFullyProcessedBeforeGitHubGetsA200", async () => {
    const ws = await makeWorkspace({ githubInstallationId: 77 });
    const res = await POST(
      signed("installation", {
        action: "deleted",
        installation: { id: 77, account: { id: 1, login: "acme", type: "Organization" } },
        sender: { id: 1, login: "alice" },
      })
    );
    expect(res.status).toBe(200);
    // No waiting: if this were fire-and-forget, a crash here would lose the deletion.
    expect(await (await getWorkspacesCollection()).countDocuments({ _id: ws._id })).toBe(0);
  });

  it("I-20 pullRequestEventsAreOnlyQueuedByTheRoute", async () => {
    const ws = await makeWorkspace({ githubInstallationId: 77 });
    const payload = {
      action: "opened",
      installation: { id: ws.githubInstallationId },
      repository: { full_name: "acme/app", id: 1 },
      pull_request: { number: 3, id: 30, title: "t", body: "", user: { login: "d", avatar_url: "" }, head: { sha: "s", ref: "f" }, base: { ref: "main" }, html_url: "u" },
    };
    expect((await POST(signed("pull_request", payload, "abc"))).status).toBe(200);
    expect((await POST(signed("pull_request", payload, "abc"))).status).toBe(200); // redelivery

    const jobs = await (await getJobsCollection()).find({}).toArray();
    expect(jobs).toEqual([expect.objectContaining({ deliveryId: "abc", status: "pending", kind: "review", prKey: "77:acme/app#3" })]);
    expect(testEnv.github.http.requests).toHaveLength(0); // nothing processed inline
  });

  it("I-20 rejectsABadSignature", async () => {
    const req = new NextRequest("http://r2s.test/api/webhooks/github", {
      method: "POST",
      body: "{}",
      headers: { "x-github-event": "installation", "x-hub-signature-256": "sha256=bad" },
    });
    expect((await POST(req)).status).toBe(401);
  });
});
