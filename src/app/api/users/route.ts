import { rateLimit, requireUser } from "@/lib/auth";
import { json, withApi } from "@/lib/http";
import { listUsers } from "@/lib/domain";
export const GET = withApi(async (request: Request) => {
  const user = await requireUser();
  await rateLimit(`user-search:user:${user.id}`, 120, 60);
  return json({ data: await listUsers(user.id, new URL(request.url).searchParams.get("q") || "") });
});
