import { requireUser } from "@/lib/auth";
import { assertSameOrigin, json, parseBody, withApi } from "@/lib/http";
import { createExpense, listExpenses } from "@/lib/domain";
import { expenseSchema } from "@/lib/domain-validation";
export const GET = withApi(async (request: Request) => json(await listExpenses((await requireUser()).id, new URL(request.url))));
export const POST = withApi(async (request: Request) => {
  assertSameOrigin(request);
  const user = await requireUser();
  return json({ data: await createExpense(user.id, await parseBody(request, expenseSchema)) }, 201);
});
