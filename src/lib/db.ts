import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// Reuse the connection pool during Next.js development hot reloads.
export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({ log: [] });

export const db = prisma;

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
