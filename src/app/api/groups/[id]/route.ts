import { requireUser } from "@/lib/auth";
import { assertSameOrigin, json, parseBody, withApi } from "@/lib/http";
import { getGroup, updateGroup } from "@/lib/domain";
import { groupUpdateSchema } from "@/lib/domain-validation";
type Context = { params: Promise<{ id: string }> };
export const GET = withApi(async (_request: Request, context: Context) => json({ data: await getGroup((await requireUser()).id, (await context.params).id) }));
export const PATCH = withApi(async (request: Request, context: Context) => {
  assertSameOrigin(request);
  const user = await requireUser();
  return json({ data: await updateGroup(user.id, (await context.params).id, await parseBody(request, groupUpdateSchema)) });
});
export const DELETE = withApi(async (request: Request, context: Context) => {
  assertSameOrigin(request);
  return json({ data: await updateGroup((await requireUser()).id, (await context.params).id, { archived: true }) });
});
