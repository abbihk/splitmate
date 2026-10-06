import { requireUser } from "@/lib/auth";
import { json, withApi } from "@/lib/http";
import { search } from "@/lib/domain";
export const GET = withApi(async (request: Request) => json({ data: await search((await requireUser()).id, new URL(request.url).searchParams.get("q") || "") }));
