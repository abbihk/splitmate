import { rateLimit, requireUser } from "@/lib/auth";
import { assertSameOrigin, json, parseBody, withApi } from "@/lib/http";
import { requestFriend } from "@/lib/domain";
import { friendRequestSchema } from "@/lib/domain-validation";
export const POST = withApi(async (request: Request) => {
  assertSameOrigin(request);
  const user = await requireUser();
  await rateLimit(`friend-request:user:${user.id}`, 20, 3600);
  return json({ data: await requestFriend(user.id, await parseBody(request, friendRequestSchema)) }, 201);
});
