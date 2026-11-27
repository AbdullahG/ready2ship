import { NextRequest, NextResponse } from "next/server";
import { requireWorkspaceApi } from "@/lib/auth/guards";
import { getPullsCollection } from "@/lib/db/collections";
import { PR_STATUS_LABELS } from "@/lib/ui/format";

const LIMIT = 20;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
): Promise<NextResponse> {
  const { workspaceId } = await params;
  const auth = await requireWorkspaceApi(request, workspaceId);
  if (auth.response) return auth.response;

  const { searchParams } = request.nextUrl;
  const status = searchParams.get("status");
  const repo = searchParams.get("repo");
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10) || 1);

  const query: Record<string, unknown> = { workspaceId: auth.workspace._id };
  if (status && status in PR_STATUS_LABELS) query.status = status;
  if (repo) query.repoFullName = repo;

  const pulls = await getPullsCollection();
  const [items, total] = await Promise.all([
    pulls.find(query).sort({ updatedAt: -1 }).skip((page - 1) * LIMIT).limit(LIMIT).toArray(),
    pulls.countDocuments(query),
  ]);

  return NextResponse.json({ pulls: items, total, page, limit: LIMIT });
}
