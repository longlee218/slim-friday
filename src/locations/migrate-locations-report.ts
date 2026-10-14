import type { MigrationReport } from "./migrate-locations";

/** Human-readable plan/outcome lines (stdout of the CLI). */
export function formatReport(r: MigrationReport): string[] {
  const out: string[] = [];
  for (const p of r.plans) {
    for (const m of p.moves) {
      out.push(`${p.name}: move repos/${m.name} -> locations/${m.name} (path ${m.path})`);
      for (const d of m.dropped) out.push(`${p.name}/${m.name}: dropped legacy field ${d}`);
    }
    if (p.channelsConverted)
      out.push(`${p.name}: convert ${p.channelsConverted} channel id(s) to objects`);
    if (p.writeYaml && !p.moves.length)
      out.push(`${p.name}: update workspace.yaml (locations/channels)`);
    for (const s of p.skipped) out.push(`${p.name}: SKIPPED ${s}`);
    for (const n of p.notes) out.push(`${p.name}: note ${n}`);
  }
  for (const f of r.failed)
    out.push(`${f.workspace}: FAILED ${f.reason} (fix the cause and re-run)`);
  if (r.nothingToDo) out.push("nothing to do");
  else if (r.applied) out.push(`applied; backup: ${r.backupDir}`);
  else out.push("dry-run: nothing written. Re-run with --apply (bot stopped).");
  return out;
}
