import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openAuthDb } from "@friday/store-sqlite";
import type { ApiLog } from "../../src/api-log";
import { createOwnerAuth, type OwnerAuth, type OwnerAuthOptions } from "../../src/auth/owner-auth";

/** An auth over a fresh db in `dir`, with a recording logger and a readable links file. */
export function testAuth(dir: string, overrides: Partial<OwnerAuthOptions> = {}) {
  const logs: object[] = [];
  const rec = (o: object) => void logs.push(o);
  const log: ApiLog = { info: rec, warn: rec, error: rec };
  const db = openAuthDb(join(dir, "engine.db"));
  const ownerLinksFile = join(dir, "logs", "owner-links.log");
  const auth: OwnerAuth = createOwnerAuth({
    db: db.db,
    schema: db.schema,
    secret: "s".repeat(32),
    baseURL: "https://friday-api.example.com",
    webOrigin: "https://friday.example.com",
    ownerEmail: "owner@example.com",
    ownerLinksFile,
    now: () => 1_700_000_000_000,
    log,
    ...overrides,
  });
  const links = () =>
    existsSync(ownerLinksFile)
      ? readFileSync(ownerLinksFile, "utf8").split("\n").filter(Boolean)
      : [];
  return { auth, links, logs, db, dbFile: join(dir, "engine.db") };
}
