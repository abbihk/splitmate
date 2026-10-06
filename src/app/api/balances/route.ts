import { requireUser } from "@/lib/auth";
import { json, withApi } from "@/lib/http";
import { allBalances } from "@/lib/domain";
export const GET = withApi(async () => json({ data: await allBalances((await requireUser()).id) }));
