import "dotenv/config";
import { defineConfig, env } from "prisma/config";

// The Prisma CLI (migrate/generate/db seed) needs DDL rights — it connects as
// the database owner via DIRECT_DATABASE_URL, never the restricted runtime
// role DATABASE_URL points at for the running application (src/lib/db.ts).
// See DATABASE.md's "Connection Roles" and SECURITY.md §5.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: env("DIRECT_DATABASE_URL"),
  },
});
