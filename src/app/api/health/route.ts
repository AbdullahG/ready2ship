import { NextResponse } from "next/server";
import { queueCounts } from "@/lib/jobs/queue";
import { workerStatus } from "@/lib/jobs/worker";

export const dynamic = "force-dynamic";

/**
 * Liveness for Docker/Cloud Run plus a glance at the job queue: a growing
 * `pending` means the worker can't keep up (raise JOB_CONCURRENCY) or is off.
 * Counts only; no tenant data.
 */
export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json({ ok: true, worker: workerStatus(), queue: await queueCounts() });
  } catch (err) {
    console.error("Health check failed:", err);
    return NextResponse.json({ ok: false, error: "database unavailable" }, { status: 503 });
  }
}
