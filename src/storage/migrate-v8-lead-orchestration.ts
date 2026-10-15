import type { Database } from "bun:sqlite";
import { logEvent, logger } from "../observability/logger";
import { countOf, hasTable, KEPT_TABLES, schemaVersion } from "./migrate";
import { V8_STATEMENTS } from "./migrate-v8-ddl";

const log = logger.child({ module: "db-migrate" });

/** Error text without nested "Error:" prefixes. */
const msgOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Schema v8: item / goal columns on `owned_tasks`, `work_plans`, `thread_events`, `effect_log`, and
 * model / generation / kind on `sessions`. Purely additive. ONE transaction: any throw (a clash with an
 * existing table/column, a count mismatch) rolls everything back and the db stays v7; `schema_version` is
 * written last. No-op when the db is already v8. The caller snapshots a v7 db first.
 */
export function migrateV8(db: Database): void {
  if (schemaVersion(db) >= 8) return;
  try {
    db.transaction(() => {
      const kept = KEPT_TABLES.filter((t) => hasTable(db, t));
      const before = kept.map((t) => countOf(db, t));
      for (const stmt of V8_STATEMENTS) db.exec(stmt);
      kept.forEach((t, i) => {
        if (countOf(db, t) !== before[i])
          throw new Error(
            `v8 migration: row count of ${t} changed (${before[i]} -> ${countOf(db, t)})`,
          );
      });
      db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '8')").run();
    })();
  } catch (err) {
    log.error({ err: msgOf(err) }, "db.migrate.failed");
    throw new Error(`v8 migration failed, the db stays at v7: ${msgOf(err)}`);
  }
  logEvent(log, "db.migrated", {
    from: 7,
    to: 8,
    added: ["owned_tasks.*", "work_plans", "thread_events", "effect_log", "sessions.*"],
  });
}
