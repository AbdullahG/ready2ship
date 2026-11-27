import { NextRequest, NextResponse } from "next/server";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { config } from "@/lib/config";
import { authorizeWorkspace } from "./workspace";
import type { MembershipRole, SessionUser } from "@/types";

// Next-specific wrappers around authorizeWorkspace. Every page and route under
// /w/[workspaceId] calls one of these itself; layouts are not relied on for
// access control.

export async function requireUserPage(): Promise<SessionUser> {
  const user = await getSession();
  if (!user) redirect("/login");
  return user;
}

export async function requireWorkspacePage(
  workspaceId: string,
  opts: { role?: MembershipRole } = {}
) {
  const user = await requireUserPage();
  const access = await authorizeWorkspace(user, workspaceId, opts);
  if (!access.ok) notFound();
  return { user, ...access };
}

const ERRORS = { 401: "Unauthorized", 403: "Forbidden", 404: "Not found" } as const;

export function jsonError(status: 400 | 401 | 403 | 404 | 409 | 422 | 502, error: string): NextResponse {
  return NextResponse.json({ error }, { status });
}

/**
 * Rejects cross-site mutations: the session cookie is SameSite=Lax, and every
 * mutating request must also carry this deployment's Origin.
 */
export function checkOrigin(request: NextRequest): NextResponse | null {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return null;
  const expected = new URL(config().baseUrl).origin;
  if (request.headers.get("origin") !== expected) return jsonError(403, "Cross-origin request rejected");
  return null;
}

export async function requireWorkspaceApi(
  request: NextRequest,
  workspaceId: string,
  opts: { role?: MembershipRole } = {}
) {
  const originError = checkOrigin(request);
  if (originError) return { response: originError } as const;
  const user = await getSession();
  const access = await authorizeWorkspace(user, workspaceId, opts);
  if (!access.ok) return { response: jsonError(access.status, ERRORS[access.status]) } as const;
  return { user: user!, ...access, response: null } as const;
}
