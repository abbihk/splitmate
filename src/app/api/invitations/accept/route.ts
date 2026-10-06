import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUser, hashToken, rateLimit } from "@/lib/auth";
import { AppError, assertSameOrigin, json, parseBody, withApi } from "@/lib/http";
import { invitationAcceptSchema } from "@/lib/validation";

export const POST = withApi(async (request: Request) => {
  assertSameOrigin(request);
  const user = await requireUser(request);
  await rateLimit(`accept-invite:${user.id}`, 15);
  const { token } = await parseBody(request, invitationAcceptSchema);
  const result = await prisma.$transaction(async (tx) => {
    const invitation = await tx.invitation.findUnique({ where: { tokenHash: hashToken(token) }, include: { invitedBy: { select: { id: true, deletedAt: true } }, group: { select: { id: true, archived: true } } } });
    if (!invitation || invitation.expiresAt <= new Date() || invitation.invitedBy.deletedAt) throw new AppError(400, "This invitation is invalid or expired.");
    if (invitation.email.toLowerCase() !== user.email) throw new AppError(403, "Sign in with the email address this invitation was sent to.");
    if (invitation.invitedById === user.id) throw new AppError(400, "You cannot accept your own invitation.");
    if (invitation.acceptedAt) return { groupId: invitation.groupId, alreadyAccepted: true };
    if (invitation.group?.archived) throw new AppError(409, "This group has been archived. Ask the owner for a new invitation.");
    if (invitation.groupId) {
      const inviter = await tx.groupMember.findUnique({ where: { groupId_userId: { groupId: invitation.groupId, userId: invitation.invitedById } } });
      if (!inviter || !["owner", "admin"].includes(inviter.role)) throw new AppError(403, "The sender can no longer invite members to this group.");
    }
    const pairKey = [user.id, invitation.invitedById].sort().join(":");
    const friendship = await tx.friendship.findUnique({ where: { pairKey } });
    if (friendship?.status === "blocked") throw new AppError(403, "This invitation cannot be accepted.");
    await tx.friendship.upsert({ where: { pairKey }, create: { pairKey, requesterId: invitation.invitedById, receiverId: user.id, status: "accepted" }, update: { status: "accepted" } });
    if (invitation.groupId) await tx.groupMember.upsert({ where: { groupId_userId: { groupId: invitation.groupId, userId: user.id } }, create: { groupId: invitation.groupId, userId: user.id }, update: {} });
    const consumed = await tx.invitation.updateMany({ where: { id: invitation.id, acceptedAt: null }, data: { acceptedAt: new Date() } });
    if (consumed.count !== 1) throw new AppError(409, "This invitation was accepted by another request. Refresh and try again.");
    // Possession of an email invitation plus the matching account verifies the invited address.
    await tx.user.update({ where: { id: user.id }, data: { emailVerified: new Date() } });
    const message = `${user.name} accepted your invitation.`;
    await tx.activity.create({ data: { type: invitation.groupId ? "group_joined" : "friend_accepted", actorId: user.id, groupId: invitation.groupId, metadata: { message },
      recipients: { create: [{ userId: user.id }, { userId: invitation.invitedById }] },
    } });
    const inviter = await tx.user.findUnique({ where: { id: invitation.invitedById }, select: { notificationPrefs: true } });
    const prefs = inviter?.notificationPrefs;
    const allowed = !(prefs && typeof prefs === "object" && !Array.isArray(prefs) && prefs.friendRequests === false);
    if (allowed) await tx.notification.create({ data: { userId: invitation.invitedById, type: "invitation_accepted", title: "Invitation accepted", message, relatedEntityId: invitation.groupId || user.id } });
    return { groupId: invitation.groupId, alreadyAccepted: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15000 });
  return json({ message: "Invitation accepted. You are connected!", ...result });
});
