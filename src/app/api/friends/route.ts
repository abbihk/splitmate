import { requireUser } from "@/lib/auth";
import { json, withApi } from "@/lib/http";
import { listFriends } from "@/lib/domain";
export const GET = withApi(async () => json({ data: await listFriends((await requireUser()).id) }));
