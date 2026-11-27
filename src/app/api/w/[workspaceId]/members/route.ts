import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireWorkspaceApi } from "@/lib/auth/guards";
import { inviteMember, listMembers, toPublicMember } from "@/lib/workspaces/members";

type Ctx = { params: Promise<{ workspaceId: string }> };

export async function GET(request: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const auth = await requireWorkspaceApi(request, (await params).workspaceId);
  if (auth.response) return auth.response;
  return NextResponse.json({ members: (await listMembers(auth.workspace)).map(toPublicMember) });
}

export async function POST(request: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const auth = await requireWorkspaceApi(request, (await params).workspaceId, { role: "owner" });
  if (auth.response) return auth.response;
  const body = (await request.json().catch(() => null)) as { login?: unknown } | null;
  if (!body || typeof body.login !== "string") return jsonError(400, "Expected { login: string }");

  const result = await inviteMember(auth.workspace, body.login, auth.user.githubUsername);
  if (!result.ok) return jsonError(result.status, result.error);
  return NextResponse.json({ members: (await listMembers(auth.workspace)).map(toPublicMember) }, { status: 201 });
}
