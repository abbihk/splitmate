import { requireUser } from "@/lib/auth";
import { assertSameOrigin, json, parseBody, withApi } from "@/lib/http";
import { addGroupMember } from "@/lib/domain";
import { addMemberSchema } from "@/lib/domain-validation";
export const POST = withApi(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(request);
  const user = await requireUser();
  const input = await parseBody(request, addMemberSchema);
  return json({ data: await addGroupMember(user.id, (await context.params).id, input.userId) }, 201);
});
