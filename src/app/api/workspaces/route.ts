import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { listMyWorkspaces } from "@/lib/auth/workspace";
import { jsonError } from "@/lib/auth/guards";

export async function GET(): Promise<NextResponse> {
  const user = await getSession();
  if (!user) return jsonError(401, "Unauthorized");
  const list = await listMyWorkspaces(user.githubId);
  return NextResponse.json({
    workspaces: list.map(({ workspace, role }) => ({
      id: workspace._id.toString(),
      account: workspace.githubAccountLogin,
      accountType: workspace.githubAccountType,
      role,
    })),
  });
}
