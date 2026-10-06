import { rateLimit, requireUser } from "@/lib/auth";
import { AppError, appUrl, assertSameOrigin, json, parseBody, withApi } from "@/lib/http";
import { createInvitation, listInvitations } from "@/lib/domain";
import { invitationSchema } from "@/lib/domain-validation";
import { sendEmail } from "@/lib/email";
import { db } from "@/lib/db";
export const GET = withApi(async () => json({ data: await listInvitations((await requireUser()).id) }));
export const POST = withApi(async (request: Request) => {
  assertSameOrigin(request);
  const user = await requireUser();
  await rateLimit(`invitation:user:${user.id}`, 20, 3600);
  if (process.env.NODE_ENV === "production" && (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM)) throw new AppError(503, "Email invitations require an email provider. Please configure email delivery.");
  const input = await parseBody(request, invitationSchema);
  const baseUrl = appUrl(request);
  const { invitation, token, inviter } = await createInvitation(user.id, input);
  const invitationUrl = `${baseUrl}/invite?token=${encodeURIComponent(token)}`;
  let sent: boolean;
  try {
    sent = await sendEmail({ to: invitation.email, subject: `${inviter.name} invited you to SplitMate`, text: `${inviter.name} invited you to share expenses on SplitMate. Sign in or register with this email and accept the invitation: ${invitationUrl}\nThis invitation expires in seven days.` });
    if (!sent && process.env.NODE_ENV === "production") throw new AppError(503, "Email invitations require an email provider. Please configure email delivery.");
  } catch (error) {
    // Leave no unusable pending invitation behind when delivery fails.
    await db.invitation.deleteMany({ where: { id: invitation.id, acceptedAt: null } });
    throw error;
  }
  return json({ data: invitation, sent, ...(process.env.NODE_ENV !== "production" ? { invitationUrl } : {}) }, 201);
});
