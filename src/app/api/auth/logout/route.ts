import { NextRequest, NextResponse } from "next/server";
import { clearSessionCookie } from "@/lib/session";
import { config } from "@/lib/config";
import { checkOrigin } from "@/lib/auth/guards";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const originError = checkOrigin(request);
  if (originError) return originError;
  await clearSessionCookie();
  return NextResponse.redirect(`${config().baseUrl}/login`, 303);
}
