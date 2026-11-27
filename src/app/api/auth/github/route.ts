import { NextRequest, NextResponse } from "next/server";
import { safeReturnTo } from "@/lib/auth/return-to";
import { config } from "@/lib/config";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { github, baseUrl, isProduction } = config();
  const state = crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: github.clientId,
    redirect_uri: `${baseUrl}/api/auth/callback`,
    state,
  });

  const response = NextResponse.redirect(
    `${github.webUrl}/login/oauth/authorize?${params}`
  );

  response.cookies.set("oauth_state", state, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    maxAge: 60 * 10,
    path: "/",
  });

  response.cookies.set("oauth_return_to", safeReturnTo(request.nextUrl.searchParams.get("returnTo")), {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    maxAge: 60 * 10,
    path: "/",
  });

  return response;
}
