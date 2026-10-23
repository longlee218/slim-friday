import { defineConfig } from "drizzle-kit";

// Paths are relative to the repo root (run via `bun run db:generate:engine`). Migrations of the engine db are generated from the TS schema; never edited by hand.
export default defineConfig({
  dialect: "sqlite",
  schema: "./packages/store-sqlite/src/schema",
  out: "./packages/store-sqlite/src/migrations",
});
