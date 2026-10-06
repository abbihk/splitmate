import { requireUser } from "@/lib/auth";
import { assertSameOrigin, json, parseBody, withApi } from "@/lib/http";
import { changeMemberRole, removeGroupMember } from "@/lib/domain";
import { memberRoleSchema } from "@/lib/domain-validation";
type Context = { params: Promise<{ id: string; userId: string }> };
export const PATCH = withApi(async (request: Request, context: Context) => {
  assertSameOrigin(request);
  const user = await requireUser();
  const params = await context.params;
  return json({ data: await changeMemberRole(user.id, params.id, params.userId, (await parseBody(request, memberRoleSchema)).role) });
});
export const DELETE = withApi(async (request: Request, context: Context) => {
  assertSameOrigin(request);
  const user = await requireUser();
  const params = await context.params;
  return json({ data: await removeGroupMember(user.id, params.id, params.userId) });
});
