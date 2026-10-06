import { requireUser } from "@/lib/auth";
import { json, withApi } from "@/lib/http";
import { listNotifications } from "@/lib/domain";
export const GET = withApi(async (request: Request) => json(await listNotifications((await requireUser()).id, new URL(request.url))));
