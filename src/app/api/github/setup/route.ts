import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { config } from "@/lib/config";
import { decryptSecret } from "@/lib/crypto";
import { getMembershipsCollection, getUsersCollection } from "@/lib/db/collections";
import {
  getWorkspaceByInstallation,
  isAccountAllowed,
  upsertWorkspaceFromInstallation,
} from "@/lib/workspaces/installations";
import { pathAfterInstall } from "@/lib/workspaces/ai-key";

// GitHub redirects here after the App is installed ("Setup URL"). The
// installation_id query param is attacker-controlled, so it's only trusted
// after GitHub confirms, with the user's own token, that this user can access it.

interface UserInstallation {
  id: number;
  account: { id: number; login: string; type: string };
}

function page(status: number, message: string): NextResponse {
  const html = `<!doctype html><meta charset="utf-8"><title>Ready2Ship</title>
<body style="font-family:system-ui;background:#0d1117;color:#e6edf3;padding:64px;text-align:center">
<h1 style="font-size:20px">🚢 Ready2Ship</h1><p data-testid="setup-error">${message}</p><p><a style="color:#58a6ff" href="/">Back to Ready2Ship</a></p></body>`;
  return new NextResponse(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function waitingPage(): NextResponse {
  const res = page(
    200,
    `<span data-testid="setup-waiting">Finishing the installation…</span> This page refreshes on its own.`
  );
  res.headers.set("refresh", "2");
  return res;
}

async function listUserInstallations(token: string): Promise<UserInstallation[] | "unauthorized"> {
  const all: UserInstallation[] = [];
  for (let pageNum = 1; pageNum <= 10; pageNum++) {
    const res = await fetch(`${config().github.apiUrl}/user/installations?per_page=100&page=${pageNum}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    if (res.status === 401) return "unauthorized";
    if (!res.ok) throw new Error(`GET /user/installations failed: ${res.status}`);
    const data = (await res.json()) as { installations: UserInstallation[] };
    all.push(...data.installations);
    if (data.installations.length < 100) break;
  }
  return all;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { baseUrl } = config();
  const installationId = Number(request.nextUrl.searchParams.get("installation_id"));
  const here = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  const relogin = NextResponse.redirect(`${baseUrl}/api/auth/github?returnTo=${encodeURIComponent(here)}`);

  if (!Number.isInteger(installationId) || installationId <= 0) {
    return page(400, "Missing installation. Start the install again from Ready2Ship.");
  }

  const session = await getSession();
  if (!session) return relogin;

  const user = await (await getUsersCollection()).findOne({ githubId: session.githubId });
  if (!user?.encryptedAccessToken) return relogin;

  const installations = await listUserInstallations(decryptSecret(user.encryptedAccessToken));
  if (installations === "unauthorized") return relogin;

  const installation = installations.find((i) => i.id === installationId);
  if (!installation) {
    return page(403, "Your GitHub account doesn't have access to that installation.");
  }

  // Seeing an installation only means the user can read one of its repos, so
  // it never grants ownership here. Owners come from the installation webhook
  // (its sender installed the app) or, for a personal account, from being
  // that account. Everyone else must be invited.
  const isAccountItself =
    installation.account.type === "User" && installation.account.id === session.githubId;
  if (isAccountItself) {
    const workspace = await upsertWorkspaceFromInstallation({
      installationId,
      account: installation.account,
      owner: { id: session.githubId, login: session.githubUsername },
    });
    if (!workspace) return page(403, "This Ready2Ship instance doesn't accept installations from that account.");
    return NextResponse.redirect(`${baseUrl}${pathAfterInstall(workspace)}`);
  }

  const workspace = await getWorkspaceByInstallation(installationId);
  if (!workspace) {
    if (!isAccountAllowed(installation.account.login)) {
      return page(403, "This Ready2Ship instance doesn't accept installations from that account.");
    }
    // GitHub redirected here before its installation webhook arrived.
    return waitingPage();
  }

  const membership = await (await getMembershipsCollection()).findOne({
    workspaceId: workspace._id,
    githubId: session.githubId,
    status: "active",
  });
  if (!membership) {
    return page(
      403,
      `Ready2Ship is installed on ${installation.account.login}, but you aren't a member of its workspace. Ask a workspace owner to invite you.`
    );
  }
  return NextResponse.redirect(
    `${baseUrl}${membership.role === "owner" ? pathAfterInstall(workspace) : `/w/${workspace._id}`}`
  );
}
