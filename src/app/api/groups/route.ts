import { requireUser } from "@/lib/auth";
import { assertSameOrigin, json, parseBody, withApi } from "@/lib/http";
import { createGroup, listGroups } from "@/lib/domain";
import { groupSchema } from "@/lib/domain-validation";
export const GET = withApi(async (request: Request) => json({ data: await listGroups((await requireUser()).id, new URL(request.url).searchParams.get("archived") === "true") }));
export const POST = withApi(async (request: Request) => {
  assertSameOrigin(request);
  const user = await requireUser();
  return json({ data: await createGroup(user.id, await parseBody(request, groupSchema)) }, 201);
});
