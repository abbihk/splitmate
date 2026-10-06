import { requireUser } from "@/lib/auth";
import { assertSameOrigin, json, parseBody, withApi } from "@/lib/http";
import { createSettlement, listSettlements } from "@/lib/domain";
import { settlementSchema } from "@/lib/domain-validation";
export const GET = withApi(async (request: Request) => json(await listSettlements((await requireUser()).id, new URL(request.url))));
export const POST = withApi(async (request: Request) => {
  assertSameOrigin(request);
  const user = await requireUser();
  return json({ data: await createSettlement(user.id, await parseBody(request, settlementSchema)) }, 201);
});
