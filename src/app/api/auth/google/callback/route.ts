import { timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { hashToken, readCookie, createSession, requireUser, OAUTH_COOKIE, secureCookieOptions } from "@/lib/auth";
import { appUrl, AppError } from "@/lib/http";
import { emailSchema } from "@/lib/validation";
import { brand } from "@/lib/brand";

const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

export async function GET(request: Request): Promise<Response> {
  let mode = "login";
  try {
    const url = new URL(request.url);
    const state = url.searchParams.get("state");
    const cookieState = await readCookie(OAUTH_COOKIE, request);
    if (!state || !cookieState || !/^[A-Za-z0-9_-]{43}$/.test(state) || state.length !== cookieState.length || !timingSafeEqual(Buffer.from(state), Buffer.from(cookieState))) throw new AppError(400, "This Google sign-in request is invalid or expired. Please start again.");
    const stateHash = hashToken(state);
    const record = await prisma.oAuthState.findUnique({ where: { stateHash } });
    if (!record || record.expiresAt <= new Date()) throw new AppError(400, "This Google sign-in request has expired. Please start again.");
    mode = record.mode;
    // Consume before contacting the provider, so the authorization response is never replayed.
    const consumed = await prisma.oAuthState.deleteMany({ where: { id: record.id, expiresAt: { gt: new Date() } } });
    if (consumed.count !== 1) throw new AppError(400, "This Google sign-in request has already been used.");
    if (url.searchParams.has("error")) throw new AppError(400, "Google sign-in was cancelled. You can try again or use your password.");
    const code = url.searchParams.get("code");
    if (!code || code.length > 4096 || !process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) throw new AppError(400, "Google sign-in could not be completed.");
    const baseUrl = appUrl(request);
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${baseUrl}/api/auth/google/callback`, grant_type: "authorization_code", code_verifier: record.verifier }),
      signal: AbortSignal.timeout(10000), cache: "no-store",
    });
    if (!tokenResponse.ok) throw new AppError(400, "Google sign-in could not be verified. Please try again.");
    const tokens = await tokenResponse.json() as { id_token?: string };
    if (!tokens.id_token) throw new AppError(400, "Google did not return a verified identity.");
    const { payload } = await jwtVerify(tokens.id_token, googleKeys, { issuer: ["https://accounts.google.com", "accounts.google.com"], audience: process.env.GOOGLE_CLIENT_ID, algorithms: ["RS256"], clockTolerance: 5 });
    if (payload.nonce !== record.nonce || payload.email_verified !== true || !payload.sub || payload.sub.length > 255 || (payload.azp && payload.azp !== process.env.GOOGLE_CLIENT_ID)) throw new AppError(400, "Google identity verification failed.");
    const email = emailSchema.parse(payload.email);
    const linked = await prisma.user.findUnique({ where: { googleId: payload.sub } });
    let userId: string;
    if (mode === "connect") {
      const current = await requireUser(request);
      if (record.userId !== current.id || email !== current.email) throw new AppError(400, "Choose the Google account with the same email as your signed-in account.");
      if (linked && linked.id !== current.id) throw new AppError(409, "This Google account is connected to another account.");
      const currentUser = await prisma.user.findUniqueOrThrow({ where: { id: current.id }, select: { googleId: true, passwordHash: true } });
      if (currentUser.googleId && currentUser.googleId !== payload.sub) throw new AppError(409, "A different Google account is already connected.");
      await prisma.user.update({ where: { id: current.id }, data: { googleId: payload.sub, emailVerified: new Date(), authProvider: currentUser.passwordHash ? "email+google" : "google" } });
      userId = current.id;
    } else if (linked) {
      if (linked.deletedAt) throw new AppError(403, "This account is no longer available.");
      userId = linked.id;
    } else {
      const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
      if (existing) throw new AppError(409, "This email already has an account. Sign in with your password, then connect Google in Settings.");
      const avatar = typeof payload.picture === "string" && payload.picture.startsWith("https://") ? payload.picture.slice(0, 2048) : null;
      const user = await prisma.user.create({ data: { email, name: (typeof payload.name === "string" ? payload.name.trim() : email.split("@")[0]).slice(0, 80) || `${brand.name} member`,
        avatarUrl: avatar, googleId: payload.sub, authProvider: "google", emailVerified: new Date(),
      } });
      userId = user.id;
    }
    const response = NextResponse.redirect(`${baseUrl}/${mode === "connect" ? "settings?google=connected" : "dashboard"}`);
    response.headers.set("Cache-Control", "no-store");
    response.cookies.set(OAUTH_COOKIE, "", { ...secureCookieOptions, maxAge: 0 });
    if (mode !== "connect") await createSession(userId, request, response, true);
    return response;
  } catch (error) {
    const message = error instanceof AppError ? error.message : "Google sign-in could not be verified. Please try again.";
    const response = NextResponse.redirect(`${appUrl(request)}/${mode === "connect" ? "settings" : "login"}?error=${encodeURIComponent(message)}`);
    response.cookies.set(OAUTH_COOKIE, "", { ...secureCookieOptions, maxAge: 0 });
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
}
