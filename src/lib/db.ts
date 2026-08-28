import { PrismaClient } from "@/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

// DATABASE_URL connects as the restricted `avant_app_runtime` role (P0-06 /
// P1 §1 cutover) — not the schema owner. It cannot UPDATE/DELETE audit_log or
// clinical_access_log; every other table has full CRUD. Migrations/seed use a
// separate, owner-level DIRECT_DATABASE_URL (see prisma.config.ts) — never
// this one. See DATABASE.md's "Connection Roles" and SECURITY.md §5.

// `pg.Pool` defaults to 10 connections per instance. In a serverless deployment
// (Vercel functions), each concurrently-running function instance opens its own
// pool — 10 connections × N concurrent instances quickly exhausts a shared
// Supabase pooler's connection cap. Capped low here; the real fix for serverless
// is pointing DATABASE_URL at Supabase's transaction-mode pooler (port 6543),
// which returns a connection after each query instead of holding one per client.
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 3 })

export const db = globalForPrisma.prisma ?? new PrismaClient({ adapter })

// Cache across hot-reloads in dev AND across warm serverless invocations in
// production — without this, previously only applied in dev, a warm Vercel
// function instance that re-evaluates this module still creates a fresh
// PrismaClient (and a fresh pool) instead of reusing the one from its last
// invocation, needlessly multiplying open connections.
globalForPrisma.prisma = db
