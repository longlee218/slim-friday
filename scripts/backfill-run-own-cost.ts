/**
 * One-off: rewrite `runs.cost_usd` from the SDK session total to the run's own cost (see `ownCostOfRun`).
 * Dry run by default (prints per-session before/after); `--apply` copies the db to `<db>.bak-own-cost` first and
 * writes a marker file next to it, so a second `--apply` is refused (it would take the delta of deltas).
 * Usage: bun scripts/backfill-run-own-cost.ts [--db <path>] [--apply]
 */
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dbPath = args.includes("--db")
  ? (args[args.indexOf("--db") + 1] as string)
  : join(homedir(), ".friday", "data", "agent.db");
const marker = `${dbPath}.own-cost-done`;

if (apply && existsSync(marker)) {
  process.stdout.write(`refused: ${marker} exists (already applied)\n`);
  process.exit(1);
}
if (apply) copyFileSync(dbPath, `${dbPath}.bak-own-cost`);

const db = new Database(dbPath, apply ? undefined : { readonly: true });
const rows = db
  .query<{ id: string; session: string; cost: number }, []>(
    `SELECT r.id AS id, t.session_id AS session, r.cost_usd AS cost
     FROM runs r JOIN turns t ON t.id = r.turn_id
     WHERE t.session_id IS NOT NULL ORDER BY t.session_id, t.started_at, r.rowid`,
  )
  .all();

// Per session: the stored values are running totals; a run's own cost is the rise over the earlier runs' sum.
const fixes: { id: string; cost: number }[] = [];
const report = new Map<string, { before: number; after: number }>();
let session = "";
let prior = 0;
for (const r of rows) {
  if (r.session !== session) {
    session = r.session;
    prior = 0;
  }
  const own = r.cost >= prior ? r.cost - prior : r.cost;
  prior += own;
  fixes.push({ id: r.id, cost: own });
  const s = report.get(session) ?? { before: 0, after: 0 };
  s.before += r.cost;
  s.after += own;
  report.set(session, s);
}

for (const [s, v] of [...report].sort((a, b) => b[1].before - a[1].before).slice(0, 15))
  process.stdout.write(`${s.slice(0, 8)} summed ${v.before.toFixed(2)} -> own ${v.after.toFixed(2)}\n`);
const totalBefore = [...report.values()].reduce((a, v) => a + v.before, 0);
const totalAfter = [...report.values()].reduce((a, v) => a + v.after, 0);
process.stdout.write(
  `${rows.length} runs, ${report.size} sessions: ${totalBefore.toFixed(2)} -> ${totalAfter.toFixed(2)} USD\n`,
);

if (apply) {
  const update = db.query("UPDATE runs SET cost_usd = ? WHERE id = ?");
  db.transaction(() => {
    for (const f of fixes) update.run(f.cost, f.id);
  })();
  writeFileSync(marker, new Date().toISOString());
  process.stdout.write("applied\n");
} else process.stdout.write("dry run: nothing written (use --apply)\n");
