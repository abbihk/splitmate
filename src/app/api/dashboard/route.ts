import { requireUser } from "@/lib/auth";
import { json, withApi } from "@/lib/http";
import { dashboard } from "@/lib/domain";
export const GET = withApi(async () => json({ data: await dashboard(await requireUser()) }));
