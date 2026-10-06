import { requireUser } from "@/lib/auth";
import { assertSameOrigin, json, withApi } from "@/lib/http";
import { respondFriend } from "@/lib/domain";
export const PATCH = withApi(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(request);
  return json({ data: await respondFriend((await requireUser()).id, (await context.params).id, true) });
});
