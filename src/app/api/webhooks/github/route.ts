import { NextRequest, NextResponse } from "next/server";
import { verifyWebhookSignature } from "@/lib/github/webhooks";
import { handleInstallation } from "@/lib/github/pipeline";
import { enqueueWebhook } from "@/lib/jobs/handlers";
import { wakeWorker } from "@/lib/jobs/worker";

export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const signature = request.headers.get("x-hub-signature-256");
  const event = request.headers.get("x-github-event");

  const payload = await request.text();

  if (!verifyWebhookSignature(payload, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const body = JSON.parse(payload);

  // Installation changes (notably uninstall, which deletes the workspace's key
  // and data) are quick and must not be lost: process them before answering,
  // so a failure returns 500 and GitHub can redeliver.
  if (event === "installation") {
    await handleInstallation(body as Parameters<typeof handleInstallation>[0]);
    return NextResponse.json({ ok: true });
  }

  // Everything else goes through the durable job queue (src/lib/jobs): the
  // worker retries transient failures and survives restarts.
  const { queued } = await enqueueWebhook(event ?? "", body, request.headers.get("x-github-delivery"));
  if (queued) wakeWorker();
  return NextResponse.json({ ok: true });
}
