import { chmodSync, cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { WorkspacePlan } from "./migrate-locations";

/** Copy every workspace.yaml and `repos/` tree to `backups/locations-<ts>/` (0700), minus the moved checkouts. */
export function backup(home: string, plans: WorkspacePlan[], ts: string): string {
  const dir = join(home, "backups", `locations-${ts}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  for (const p of plans) {
    const src = join(home, "workspaces", p.name);
    mkdirSync(join(dir, p.name), { recursive: true, mode: 0o700 });
    cpSync(join(src, "workspace.yaml"), join(dir, p.name, "workspace.yaml"));
    if (!existsSync(join(src, "repos"))) continue;
    // A checkout inside `repos/<n>/` is moved by rename (can be huge), so it is not copied.
    const skip = new Set(p.moves.flatMap((m) => (m.insideOld ? [m.insideOld] : [])));
    cpSync(join(src, "repos"), join(dir, p.name, "repos"), {
      recursive: true,
      verbatimSymlinks: true,
      filter: (s) => !skip.has(s),
    });
  }
  return dir;
}
