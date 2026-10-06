import { requireUser } from "@/lib/auth";
import { assertSameOrigin, json, withApi } from "@/lib/http";
import { friendDetails, removeFriend } from "@/lib/domain";
type Context = { params: Promise<{ id: string }> };
export const GET = withApi(async (_request: Request, context: Context) => json({ data: await friendDetails((await requireUser()).id, (await context.params).id) }));
export const DELETE = withApi(async (request: Request, context: Context) => {
  assertSameOrigin(request);
  return json({ data: await removeFriend((await requireUser()).id, (await context.params).id) });
});
