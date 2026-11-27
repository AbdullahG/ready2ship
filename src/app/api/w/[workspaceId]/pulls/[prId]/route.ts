import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { jsonError, requireWorkspaceApi } from "@/lib/auth/guards";
import { getFindingsCollection, getPullsCollection } from "@/lib/db/collections";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; prId: string }> }
): Promise<NextResponse> {
  const { workspaceId, prId } = await params;
  const auth = await requireWorkspaceApi(request, workspaceId);
  if (auth.response) return auth.response;
  if (!ObjectId.isValid(prId)) return jsonError(404, "Not found");

  const scope = { workspaceId: auth.workspace._id };
  const id = new ObjectId(prId);
  const [pr, findings] = await Promise.all([
    (await getPullsCollection()).findOne({ _id: id, ...scope }),
    (await getFindingsCollection()).find({ prId: id, ...scope }).sort({ severity: 1, createdAt: 1 }).toArray(),
  ]);
  if (!pr) return jsonError(404, "Not found");

  return NextResponse.json({ pr, findings });
}
