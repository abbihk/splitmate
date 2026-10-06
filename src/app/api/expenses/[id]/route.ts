import { requireUser } from "@/lib/auth";
import { assertSameOrigin, json, parseBody, withApi } from "@/lib/http";
import { deleteExpense, getExpense, updateExpense } from "@/lib/domain";
import { expenseSchema } from "@/lib/domain-validation";
type Context = { params: Promise<{ id: string }> };
export const GET = withApi(async (_request: Request, context: Context) => json({ data: await getExpense((await requireUser()).id, (await context.params).id) }));
export const PATCH = withApi(async (request: Request, context: Context) => {
  assertSameOrigin(request);
  const user = await requireUser();
  return json({ data: await updateExpense(user.id, (await context.params).id, await parseBody(request, expenseSchema)) });
});
export const DELETE = withApi(async (request: Request, context: Context) => {
  assertSameOrigin(request);
  return json({ data: await deleteExpense((await requireUser()).id, (await context.params).id) });
});
