import { requireUser } from "@/lib/auth";
import { json, withApi } from "@/lib/http";
import { listActivity } from "@/lib/domain";
export const GET = withApi(async (request: Request) => json(await listActivity((await requireUser()).id, new URL(request.url))));
