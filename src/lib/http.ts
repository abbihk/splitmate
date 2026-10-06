import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";

export class AppError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
    this.name = "AppError";
  }
}

export function json(data: unknown, status = 200): NextResponse {
  const safe = JSON.parse(JSON.stringify(data, (_key, value) => typeof value === "bigint" ? value.toString() : value));
  return NextResponse.json(safe, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

export function apiError(error: unknown): NextResponse {
  if (error instanceof AppError) return json({ error: error.message, ...(error.details ? { details: error.details } : {}) }, error.status);
  if (error instanceof z.ZodError) return json({ error: "Please check the highlighted fields.", details: error.flatten() }, 400);
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") return json({ error: "A record with these details already exists." }, 409);
    if (error.code === "P2025") return json({ error: "This record could not be found." }, 404);
    if (error.code === "P2003") return json({ error: "This record is still referenced by financial history." }, 409);
    if (error.code === "P2034") return json({ error: "Another update happened at the same time. Please try again." }, 409);
  }
  // Deliberately do not log request bodies, database query errors, tokens, or credentials.
  return json({ error: "We could not complete this request. Please try again." }, 500);
}

export function appUrl(request?: Request): string {
  const configured = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  const value = configured || (process.env.NODE_ENV !== "production" && request ? new URL(request.url).origin : "");
  if (!value) throw new AppError(503, "The application URL has not been configured.");
  let url: URL;
  try { url = new URL(value); } catch { throw new AppError(503, "The application URL is invalid."); }
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") throw new AppError(503, "The production application URL must use HTTPS.");
  return url.origin;
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  if (!origin || origin === "null" || (site && site !== "same-origin" && site !== "none")) {
    throw new AppError(403, "This request must come from this application.");
  }
  let parsed: URL;
  try { parsed = new URL(origin); } catch { throw new AppError(403, "Invalid request origin."); }
  if (parsed.origin !== appUrl(request)) throw new AppError(403, "Invalid request origin.");
}

export async function parseBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new AppError(415, "Send this request as JSON.");
  const limit = 64 * 1024;
  const length = Number(request.headers.get("content-length") || "0");
  if (!Number.isFinite(length) || length > limit) throw new AppError(413, "This request is too large.");
  const reader = request.body?.getReader();
  if (!reader) throw new AppError(400, "A request body is required.");
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) { await reader.cancel(); throw new AppError(413, "This request is too large."); }
    chunks.push(value);
  }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(buffer)); } catch { throw new AppError(400, "The JSON request body is invalid."); }
  return schema.parse(body);
}

export function withApi<T extends unknown[]>(handler: (...args: T) => Promise<Response>) {
  return async (...args: T): Promise<Response> => {
    try { return await handler(...args); } catch (error) { return apiError(error); }
  };
}
