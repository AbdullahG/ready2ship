import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireWorkspaceApi } from "@/lib/auth/guards";
import { changeMemberRole, listMembers, removeMember, toPublicMember } from "@/lib/workspaces/members";

type Ctx = { params: Promise<{ workspaceId: string; memberId: string }> };

export async function PATCH(request: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const { workspaceId, memberId } = await params;
  const auth = await requireWorkspaceApi(request, workspaceId, { role: "owner" });
  if (auth.response) return auth.response;
  const body = (await request.json().catch(() => null)) as { role?: unknown } | null;
  if (body?.role !== "owner" && body?.role !== "member") return jsonError(400, "role must be owner or member");

  const result = await changeMemberRole(auth.workspace, memberId, body.role);
  if (!result.ok) return jsonError(result.status, result.error);
  return NextResponse.json({ members: (await listMembers(auth.workspace)).map(toPublicMember) });
}

export async function DELETE(request: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const { workspaceId, memberId } = await params;
  const auth = await requireWorkspaceApi(request, workspaceId, { role: "owner" });
  if (auth.response) return auth.response;

  const result = await removeMember(auth.workspace, memberId);
  if (!result.ok) return jsonError(result.status, result.error);
  return NextResponse.json({ members: (await listMembers(auth.workspace)).map(toPublicMember) });
}
