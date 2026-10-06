import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/http";

export const SESSION_COOKIE = process.env.NODE_ENV === "production" ? "__Host-splitmate_session" : "splitmate_session";
export const OAUTH_COOKIE = process.env.NODE_ENV === "production" ? "__Host-splitmate_oauth" : "splitmate_oauth";
export const secureCookieOptions = { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" as const, path: "/" };
export const safeUserSelect = {
  id: true, name: true, email: true, avatarUrl: true, authProvider: true,
  defaultCurrency: true, timezone: true, dateFormat: true, notificationPrefs: true,
  emailVerified: true, createdAt: true, updatedAt: true,
} satisfies Prisma.UserSelect;
export type SafeUser = Prisma.UserGetPayload<{ select: typeof safeUserSelect }> & { hasPassword?: boolean; googleConnected?: boolean };
export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");
export const randomToken = (): string => randomBytes(32).toString("base64url");
export const hashPassword = (password: string): Promise<string> => bcrypt.hash(password, 12);
export const checkPassword = (password: string, hash: string): Promise<boolean> => bcrypt.compare(password, hash);

export function clientIp(request: Request): string {
  // Only trust forwarding headers when the deployment's proxy strips client-supplied values.
  return process.env.TRUST_PROXY === "true" ? (request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown").slice(0, 64) : "unknown";
}

export async function rateLimit(key: string, limit: number, windowSeconds = 900): Promise<void> {
  const hashedKey = hashToken(key);
  const now = new Date();
  await prisma.rateLimit.updateMany({ where: { key: hashedKey, expiresAt: { lte: now } }, data: { count: 0, expiresAt: new Date(now.getTime() + windowSeconds * 1000) } });
  const record = await prisma.rateLimit.upsert({ where: { key: hashedKey },
    create: { key: hashedKey, count: 1, expiresAt: new Date(now.getTime() + windowSeconds * 1000) },
    update: { count: { increment: 1 } },
  });
  if (record.count > limit) throw new AppError(429, "Too many attempts. Please wait a few minutes and try again.");
}

export async function readCookie(name: string, request?: Request): Promise<string | undefined> {
  if (!request) return (await cookies()).get(name)?.value;
  const entry = request.headers.get("cookie")?.split(";").find((part) => part.trim().startsWith(`${name}=`));
  if (!entry) return undefined;
  try { return decodeURIComponent(entry.trim().slice(name.length + 1)); } catch { return undefined; }
}

export async function getSession(request?: Request) {
  const token = await readCookie(SESSION_COOKIE, request);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AppError(401, "Please sign in to continue.");
  const session = await prisma.session.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: { select: { ...safeUserSelect, deletedAt: true, passwordHash: true, googleId: true } } } });
  if (!session || session.expiresAt <= new Date() || session.user.deletedAt) throw new AppError(401, "Your session has expired. Please sign in again.");
  if (Date.now() - session.lastUsedAt.getTime() > 5 * 60 * 1000) {
    await prisma.session.updateMany({ where: { id: session.id }, data: { lastUsedAt: new Date() } });
  }
  return session;
}

export function publicUser(user: Prisma.UserGetPayload<{ select: typeof safeUserSelect }> & { passwordHash?: string | null; googleId?: string | null; deletedAt?: Date | null }): SafeUser {
  const { passwordHash, googleId, deletedAt: _deletedAt, ...safe } = user;
  void _deletedAt;
  return { ...safe, hasPassword: Boolean(passwordHash), googleConnected: Boolean(googleId) };
}

export async function requireUser(request?: Request): Promise<SafeUser> {
  return publicUser((await getSession(request)).user);
}

export async function getCurrentUser(): Promise<SafeUser | null> {
  try { return await requireUser(); }
  catch (error) { if (error instanceof AppError && error.status === 401) return null; throw error; }
}

export async function createSession(userId: string, request: Request, response: NextResponse, remember = false, expectedPasswordHash?: string): Promise<void> {
  const token = randomToken();
  const duration = remember ? 30 * 24 * 60 * 60 : 24 * 60 * 60;
  await prisma.$transaction(async (tx) => {
    const active = await tx.user.findFirst({ where: { id: userId, deletedAt: null, ...(expectedPasswordHash ? { passwordHash: expectedPasswordHash } : {}) }, select: { id: true } });
    if (!active) throw new AppError(401, "Your account credentials changed. Please sign in again.");
    await tx.session.create({ data: { userId, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + duration * 1000),
      userAgent: request.headers.get("user-agent")?.slice(0, 500), ipAddress: clientIp(request), remember,
    } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  response.cookies.set(SESSION_COOKIE, token, { ...secureCookieOptions, ...(remember ? { maxAge: duration } : {}) });
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set(SESSION_COOKIE, "", { ...secureCookieOptions, maxAge: 0 });
}
