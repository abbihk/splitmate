import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { assertSameOrigin, json, withApi } from "@/lib/http";

export const GET = withApi(async (request: Request) => {
  const current = await getSession(request);
  const records = await prisma.session.findMany({ where: { userId: current.userId, expiresAt: { gt: new Date() } }, select: { id: true, createdAt: true, lastUsedAt: true, expiresAt: true, userAgent: true }, orderBy: { lastUsedAt: "desc" } });
  return json({ sessions: records.map((session) => ({ ...session, current: session.id === current.id })) });
});
export const DELETE = withApi(async (request: Request) => {
  assertSameOrigin(request);
  const current = await getSession(request);
  await prisma.session.deleteMany({ where: { userId: current.userId, id: { not: current.id } } });
  return json({ message: "Other devices have been signed out." });
});
