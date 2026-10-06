import { prisma } from "@/lib/db";
import { checkPassword, hashPassword, getSession, clearSessionCookie, clientIp, rateLimit } from "@/lib/auth";
import { assertSameOrigin, json, parseBody, AppError, withApi } from "@/lib/http";
import { changePasswordSchema } from "@/lib/validation";

export const PATCH = withApi(async (request: Request) => {
  assertSameOrigin(request);
  const session = await getSession(request);
  await rateLimit(`change-password:${session.userId}:${clientIp(request)}`, 5);
  const input = await parseBody(request, changePasswordSchema);
  if (!session.user.passwordHash) throw new AppError(400, "Use the forgot password form to verify your email and create your first password.");
  if (!await checkPassword(input.currentPassword, session.user.passwordHash)) throw new AppError(400, "Your current password is incorrect.");
  const passwordHash = await hashPassword(input.password);
  await prisma.$transaction(async (tx) => {
    const activeSession = await tx.session.findFirst({ where: { id: session.id, userId: session.userId, expiresAt: { gt: new Date() }, user: { deletedAt: null, passwordHash: session.user.passwordHash } }, select: { id: true } });
    if (!activeSession) throw new AppError(401, "Your account credentials changed. Please sign in again.");
    const changed = await tx.user.updateMany({ where: { id: session.userId, deletedAt: null, passwordHash: session.user.passwordHash }, data: { passwordHash } });
    if (changed.count !== 1) throw new AppError(409, "Your password changed during this request. Please sign in again.");
    await tx.session.deleteMany({ where: { userId: session.userId } });
    await tx.passwordReset.updateMany({ where: { userId: session.userId, usedAt: null }, data: { usedAt: new Date() } });
  });
  const response = json({ message: "Password changed. Please sign in again on each device." });
  clearSessionCookie(response);
  return response;
});
