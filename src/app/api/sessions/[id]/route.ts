import { prisma } from "@/lib/db";
import { getSession, clearSessionCookie } from "@/lib/auth";
import { assertSameOrigin, json, AppError, withApi } from "@/lib/http";

export const DELETE = withApi(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(request);
  const current = await getSession(request);
  const { id } = await context.params;
  const removed = await prisma.session.deleteMany({ where: { id, userId: current.userId } });
  if (!removed.count) throw new AppError(404, "This session could not be found.");
  const response = json({ message: "This device has been signed out." });
  if (id === current.id) clearSessionCookie(response);
  return response;
});
