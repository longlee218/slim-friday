import { Database } from "bun:sqlite";
import { loadConfig } from "../src/config/agent-config";
import { workspacePaths } from "../src/config/workspace-paths";

/**
 * CLI: `bun scripts/list-code-written-artifacts.ts`. Opens the db READ-ONLY and lists the artifacts the code wrote itself
 * (`summary` = 1: old result summaries and plan versions). They are hidden from `ListArtifacts` and `SearchArtifacts`; this
 * lists them (id, size, title, path) so the owner can delete the files by hand. Nothing is changed.
 */
const db = new Database(workspacePaths(loadConfig().agentHome).dbFile, { readonly: true });
try {
  const rows = db
    .query<{ id: string; size: number; title: string; path: string }, []>(
      "SELECT id, size, title, path FROM artifacts WHERE summary = 1 ORDER BY created_at",
    )
    .all();
  for (const r of rows) process.stdout.write(`${r.id}\t${r.size}B\t${r.title}\t${r.path}\n`);
  process.stdout.write(`${rows.length} code-written artifact(s)\n`);
} finally {
  db.close();
}
