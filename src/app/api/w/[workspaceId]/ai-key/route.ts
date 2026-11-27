import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireWorkspaceApi } from "@/lib/auth/guards";
import { getWorkspacesCollection } from "@/lib/db/collections";
import { publicAiState, removeWorkspaceKey, saveWorkspaceKey } from "@/lib/workspaces/ai-key";

type Ctx = { params: Promise<{ workspaceId: string }> };

async function freshState(workspaceId: unknown) {
  const ws = await (await getWorkspacesCollection()).findOne({ _id: workspaceId as never });
  return publicAiState(ws!, "owner");
}

export async function GET(request: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const auth = await requireWorkspaceApi(request, (await params).workspaceId);
  if (auth.response) return auth.response;
  return NextResponse.json({ ai: publicAiState(auth.workspace, auth.membership.role) });
}

export async function PUT(request: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const auth = await requireWorkspaceApi(request, (await params).workspaceId, { role: "owner" });
  if (auth.response) return auth.response;

  const body = (await request.json().catch(() => null)) as { key?: unknown } | null;
  if (!body || typeof body.key !== "string") return jsonError(400, "Expected { key: string }");

  const result = await saveWorkspaceKey(auth.workspace, body.key, auth.user.githubUsername);
  if (!result.ok) return jsonError(422, result.reason);
  return NextResponse.json({ ai: await freshState(auth.workspace._id) });
}

export async function DELETE(request: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const auth = await requireWorkspaceApi(request, (await params).workspaceId, { role: "owner" });
  if (auth.response) return auth.response;
  await removeWorkspaceKey(auth.workspace, auth.user.githubUsername);
  return NextResponse.json({ ai: await freshState(auth.workspace._id) });
}
