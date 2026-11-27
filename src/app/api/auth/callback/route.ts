import { NextRequest, NextResponse } from "next/server";
import { createSession, setSessionCookie } from "@/lib/session";
import { getUsersCollection } from "@/lib/db/collections";
import { config } from "@/lib/config";
import { encryptSecret } from "@/lib/crypto";
import { safeReturnTo } from "@/lib/auth/return-to";
import { activatePendingInvites } from "@/lib/workspaces/members";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { github, baseUrl } = config();
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const storedState = request.cookies.get("oauth_state")?.value;

  if (!code || !state || state !== storedState) {
    return NextResponse.redirect(
      `${baseUrl}/login?error=invalid_state`
    );
  }

  const tokenRes = await fetch(
    `${github.webUrl}/login/oauth/access_token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: github.clientId,
        client_secret: github.clientSecret,
        code,
        redirect_uri: `${baseUrl}/api/auth/callback`,
      }),
    }
  );

  const tokenData = await tokenRes.json();
  if (tokenData.error || !tokenData.access_token) {
    return NextResponse.redirect(
      `${baseUrl}/login?error=token_exchange`
    );
  }

  const userRes = await fetch(`${github.apiUrl}/user`, {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      Accept: "application/vnd.github+json",
    },
  });

  if (!userRes.ok) {
    return NextResponse.redirect(`${baseUrl}/login?error=github_user`);
  }
  const githubUser = await userRes.json();

  const users = await getUsersCollection();
  await users.updateOne(
    { githubId: githubUser.id },
    {
      $set: {
        githubId: githubUser.id,
        githubUsername: githubUser.login,
        encryptedAccessToken: encryptSecret(tokenData.access_token),
        avatarUrl: githubUser.avatar_url,
      },
      $unset: { githubAccessToken: "" },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );

  await activatePendingInvites(githubUser.id);

  const token = await createSession({
    id: githubUser.id.toString(),
    githubId: githubUser.id,
    githubUsername: githubUser.login,
    avatarUrl: githubUser.avatar_url,
  });

  const returnTo = safeReturnTo(request.cookies.get("oauth_return_to")?.value);
  const response = NextResponse.redirect(`${baseUrl}${returnTo}`);
  await setSessionCookie(token);

  response.cookies.delete("oauth_state");
  response.cookies.delete("oauth_return_to");
  return response;
}
