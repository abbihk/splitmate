import { requireUser } from "@/lib/auth";
import { json, withApi } from "@/lib/http";

export const GET = withApi(async (request: Request) => json({ user: await requireUser(request) }));
