import { requireUser } from "@/lib/auth";
import { json, withApi } from "@/lib/http";
import { groupBalances } from "@/lib/domain";
export const GET = withApi(async (_request: Request, context: { params: Promise<{ id: string }> }) => json({ data: await groupBalances((await requireUser()).id, (await context.params).id) }));
