import { prisma } from "@/lib/db";
import { hashToken, randomToken, rateLimit, clientIp } from "@/lib/auth";
import { appUrl, assertSameOrigin, json, parseBody, withApi, AppError } from "@/lib/http";
import { forgotPasswordSchema } from "@/lib/validation";
import { sendEmail } from "@/lib/email";
import { brand } from "@/lib/brand";

export const POST = withApi(async (request: Request) => {
  assertSameOrigin(request);
  await rateLimit(`reset:ip:${clientIp(request)}`, 15, 3600);
  const input = await parseBody(request, forgotPasswordSchema);
  await rateLimit(`reset:email:${input.email}`, 3, 3600);
  if (process.env.NODE_ENV === "production" && (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM)) throw new AppError(503, "Password recovery email is not configured. Please contact the administrator.");
  const message = "If an account uses this email, we have sent a password reset link.";
  const user = await prisma.user.findUnique({ where: { email: input.email }, select: { id: true, deletedAt: true } });
  if (!user || user.deletedAt) return json({ message });
  const token = randomToken();
  const tokenHash = hashToken(token);
  await prisma.$transaction(async (tx) => {
    await tx.passwordReset.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });
    await tx.passwordReset.create({ data: { userId: user.id, tokenHash, expiresAt: new Date(Date.now() + 30 * 60 * 1000) } });
  });
  const url = `${appUrl(request)}/reset-password?token=${encodeURIComponent(token)}`;
  let sent = false;
  try { sent = await sendEmail({ to: input.email, subject: `Reset your ${brand.name} password`, text: `Reset your password using this link:\n${url}\n\nThis link expires in 30 minutes and can be used once. If you did not request it, you can ignore this email.` }); }
  catch { /* Keep recovery responses identical for existing and unknown accounts. */ }
  if (!sent && process.env.NODE_ENV === "production") await prisma.passwordReset.deleteMany({ where: { tokenHash } });
  return json({ message, ...(process.env.NODE_ENV !== "production" && !sent ? { developmentResetUrl: url } : {}) });
});
