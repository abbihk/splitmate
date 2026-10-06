import { prisma } from "@/lib/db";
import { checkPassword, createSession, hashPassword, publicUser, safeUserSelect, rateLimit, clientIp } from "@/lib/auth";
import { assertSameOrigin, json, parseBody, AppError, withApi } from "@/lib/http";
import { loginSchema } from "@/lib/validation";

let dummyHash: Promise<string> | undefined;
export const POST = withApi(async (request: Request) => {
  assertSameOrigin(request);
  await rateLimit(`login:ip:${clientIp(request)}`, 60);
  const input = await parseBody(request, loginSchema);
  await rateLimit(`login:email:${input.email}`, 10);
  const user = await prisma.user.findUnique({ where: { email: input.email }, select: { ...safeUserSelect, passwordHash: true, googleId: true, deletedAt: true } });
  dummyHash ??= hashPassword("Placeholder9!NeverAUser");
  const valid = await checkPassword(input.password, user?.passwordHash || await dummyHash);
  if (!user || user.deletedAt || !user.passwordHash || !valid) throw new AppError(401, "The email or password is incorrect.");
  const response = json({ user: publicUser(user) });
  await createSession(user.id, request, response, input.rememberMe, user.passwordHash);
  return response;
});
