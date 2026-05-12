import { PrismaClient } from "@prisma/client";

// Reuse a single PrismaClient across hot reloads in development so we
// don't exhaust the database's connection pool. In production the
// module is evaluated once per cold start, so a plain instance is fine.
const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
