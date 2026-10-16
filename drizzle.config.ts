import { defineConfig } from "drizzle-kit";

// Migrations are generated from the TS schema; `memory_fts` (FTS5) lives in a hand-written custom migration.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/storage/schema",
  out: "./src/storage/migrations",
});
