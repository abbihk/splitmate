import { prisma } from "@/lib/db";
import { clearSessionCookie, hashToken, readCookie, SESSION_COOKIE } from "@/lib/auth";
import { assertSameOrigin, json, withApi } from "@/lib/http";

export const POST = withApi(async (request: Request) => {
  assertSameOrigin(request);
  const token = await readCookie(SESSION_COOKIE, request);
  if (token) await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  const response = json({ message: "You have been signed out." });
  clearSessionCookie(response);
  return response;
});
