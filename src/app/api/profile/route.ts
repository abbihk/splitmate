import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { requireUser, publicUser, safeUserSelect, getSession, checkPassword, clearSessionCookie, rateLimit } from "@/lib/auth";
import { assertSameOrigin, json, parseBody, withApi, AppError } from "@/lib/http";
import { profileSchema, deleteAccountSchema } from "@/lib/validation";
import { calculateBalances } from "@/lib/balances";

export const GET = withApi(async (request: Request) => json({ user: await requireUser(request) }));
export const PATCH = withApi(async (request: Request) => {
  assertSameOrigin(request);
  const user = await requireUser(request);
  const input = await parseBody(request, profileSchema);
  const updated = await prisma.user.update({ where: { id: user.id, deletedAt: null }, data: input, select: { ...safeUserSelect, passwordHash: true, googleId: true } });
  return json({ user: publicUser(updated), message: "Your profile has been updated." });
});

export const DELETE = withApi(async (request: Request) => {
  assertSameOrigin(request);
  const session = await getSession(request);
  await rateLimit(`delete-account:${session.userId}`, 5);
  const input = await parseBody(request, deleteAccountSchema);
  if (session.user.passwordHash) {
    if (!input.currentPassword || !await checkPassword(input.currentPassword, session.user.passwordHash)) throw new AppError(400, "Enter your current password to delete your account.");
  } else if (!session.user.googleId || Date.now() - session.createdAt.getTime() > 5 * 60 * 1000) {
    throw new AppError(400, "Sign in again with Google, then delete your account within five minutes.");
  }
  await prisma.$transaction(async (tx) => {
    const current = await tx.user.findFirst({ where: { id: session.userId, deletedAt: null, passwordHash: session.user.passwordHash }, select: { id: true } });
    const activeSession = await tx.session.findFirst({ where: { id: session.id, expiresAt: { gt: new Date() } }, select: { id: true } });
    if (!current || !activeSession) throw new AppError(401, "Your account credentials changed. Please sign in again.");
    const owner = await tx.groupMember.findFirst({ where: { userId: session.userId, role: "owner", group: { archived: false } }, select: { groupId: true } });
    if (owner) throw new AppError(409, "Transfer ownership or archive every group you own before deleting your account.");
    const groupIds = (await tx.groupMember.findMany({ where: { userId: session.userId }, select: { groupId: true } })).map((item) => item.groupId);
    const expenses = await tx.expense.findMany({ where: { OR: [
      { groupId: { in: groupIds } }, { groupId: null, OR: [{ payers: { some: { userId: session.userId } } }, { participants: { some: { userId: session.userId } } }] },
    ] }, include: { payers: true, participants: true } });
    const settlements = await tx.settlement.findMany({ where: { OR: [{ groupId: { in: groupIds } }, { groupId: null, OR: [{ fromUserId: session.userId }, { toUserId: session.userId }] }] } });
    for (const groupId of [null, ...groupIds]) {
      const ledgers = calculateBalances(expenses.filter((item) => item.groupId === groupId), settlements.filter((item) => item.groupId === groupId));
      if (ledgers.some((ledger) => ledger.debts.some((debt) => debt.fromUserId === session.userId || debt.toUserId === session.userId))) throw new AppError(409, "Settle every outstanding balance before deleting your account.");
    }
    // Preserve immutable identity references in other people's shared financial history.
    await tx.user.update({ where: { id: session.userId }, data: { name: "Deleted member", email: `${session.userId}@deleted.splitmate.invalid`,
      passwordHash: null, googleId: null, emailVerified: null, avatarUrl: null, authProvider: "deleted", deletedAt: new Date(),
      notificationPrefs: { friendRequests: false, groupActivity: false, expenses: false, payments: false },
    } });
    await tx.session.deleteMany({ where: { userId: session.userId } });
    await tx.passwordReset.deleteMany({ where: { userId: session.userId } });
    await tx.oAuthState.deleteMany({ where: { userId: session.userId } });
    await tx.invitation.deleteMany({ where: { OR: [{ invitedById: session.userId }, { email: session.user.email }] } });
    await tx.friendship.deleteMany({ where: { OR: [{ requesterId: session.userId }, { receiverId: session.userId }] } });
    await tx.notification.deleteMany({ where: { userId: session.userId } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15000 });
  const response = json({ message: "Your account has been deleted. Shared financial history retains an anonymous member reference." });
  clearSessionCookie(response);
  return response;
});
