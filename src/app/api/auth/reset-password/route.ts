import { prisma } from "@/lib/db";
import { hashPassword, hashToken, clearSessionCookie, rateLimit, clientIp } from "@/lib/auth";
import { assertSameOrigin, json, parseBody, AppError, withApi } from "@/lib/http";
import { resetPasswordSchema } from "@/lib/validation";

export const POST = withApi(async (request: Request) => {
  assertSameOrigin(request);
  await rateLimit(`reset-confirm:ip:${clientIp(request)}`, 15);
  const input = await parseBody(request, resetPasswordSchema);
  const record = await prisma.passwordReset.findUnique({ where: { tokenHash: hashToken(input.token) }, include: { user: { select: { deletedAt: true, googleId: true } } } });
  if (!record || record.usedAt || record.expiresAt <= new Date() || record.user.deletedAt) throw new AppError(400, "This reset link is invalid or expired. Please request a new one.");
  const passwordHash = await hashPassword(input.password);
  await prisma.$transaction(async (tx) => {
    const consumed = await tx.passwordReset.updateMany({ where: { id: record.id, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
    if (consumed.count !== 1) throw new AppError(400, "This reset link has already been used.");
    const changed = await tx.user.updateMany({ where: { id: record.userId, deletedAt: null }, data: { passwordHash, emailVerified: new Date(), authProvider: record.user.googleId ? "email+google" : "email" } });
    if (changed.count !== 1) throw new AppError(400, "This account is no longer available.");
    await tx.passwordReset.updateMany({ where: { userId: record.userId, usedAt: null }, data: { usedAt: new Date() } });
    await tx.session.deleteMany({ where: { userId: record.userId } });
  });
  const response = json({ message: "Your password has been saved. Please sign in with your new password." });
  clearSessionCookie(response);
  return response;
});
