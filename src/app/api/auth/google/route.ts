import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { hashToken, randomToken, requireUser, rateLimit, clientIp, OAUTH_COOKIE, secureCookieOptions } from "@/lib/auth";
import { appUrl, AppError } from "@/lib/http";

export async function GET(request: Request): Promise<Response> {
  try {
    const baseUrl = appUrl(request);
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) throw new AppError(503, "Google sign-in is not configured. Please use your email and password.");
    const site = request.headers.get("sec-fetch-site");
    if (site === "cross-site") throw new AppError(403, "Start Google sign-in from this application.");
    const origin = request.headers.get("origin");
    if (origin && origin !== baseUrl) throw new AppError(403, "Start Google sign-in from this application.");
    await rateLimit(`oauth:ip:${clientIp(request)}`, 30);
    const mode = new URL(request.url).searchParams.get("mode") === "connect" ? "connect" : "login";
    const user = mode === "connect" ? await requireUser(request) : null;
    const state = randomToken();
    const verifier = randomToken();
    const nonce = randomToken();
    await prisma.oAuthState.deleteMany({ where: { expiresAt: { lte: new Date() } } });
    await prisma.oAuthState.create({ data: { stateHash: hashToken(state), verifier, nonce, mode, userId: user?.id, expiresAt: new Date(Date.now() + 10 * 60 * 1000) } });
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: `${baseUrl}/api/auth/google/callback`,
      response_type: "code", scope: "openid email profile", state, nonce,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", prompt: "select_account",
    }).toString();
    const response = NextResponse.redirect(url);
    response.headers.set("Cache-Control", "no-store");
    response.cookies.set(OAUTH_COOKIE, state, { ...secureCookieOptions, maxAge: 600 });
    return response;
  } catch (error) {
    const message = error instanceof AppError ? error.message : "Google sign-in could not be started. Please try again.";
    return NextResponse.redirect(`${appUrl(request)}/login?error=${encodeURIComponent(message)}`);
  }
}
