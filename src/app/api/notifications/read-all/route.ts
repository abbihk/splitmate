import { requireUser } from "@/lib/auth";
import { assertSameOrigin, json, withApi } from "@/lib/http";
import { readNotification } from "@/lib/domain";
export const PATCH = withApi(async (request: Request) => {
  assertSameOrigin(request);
  return json({ data: await readNotification((await requireUser()).id) });
});
