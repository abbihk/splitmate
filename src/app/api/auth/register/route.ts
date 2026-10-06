import { prisma } from "@/lib/db";
import { createSession, hashPassword, publicUser, safeUserSelect, rateLimit, clientIp } from "@/lib/auth";
import { assertSameOrigin, json, parseBody, AppError, withApi } from "@/lib/http";
import { registerSchema } from "@/lib/validation";

export const POST = withApi(async (request: Request) => {
  assertSameOrigin(request);
  await rateLimit(`register:ip:${clientIp(request)}`, 15, 3600);
  const input = await parseBody(request, registerSchema);
  if (await prisma.user.findUnique({ where: { email: input.email }, select: { id: true } })) throw new AppError(409, "An account already uses this email. Please sign in.");
  const passwordHash = await hashPassword(input.password);
  const user = await prisma.user.create({ data: { name: input.name, email: input.email, passwordHash }, select: { ...safeUserSelect, passwordHash: true, googleId: true } });
  const response = json({ user: publicUser(user) }, 201);
  await createSession(user.id, request, response, false, passwordHash);
  return response;
});
