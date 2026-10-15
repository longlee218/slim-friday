import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { backup } from "./migrate-locations-backup";
import { NOTE, planRepo } from "./migrate-locations-plan-repo";
import { writeWorkspaceYaml } from "./migrate-locations-yaml";

/**
 * Filesystem migration `workspaces/<ws>/repos/<n>/repo.yaml` -> `workspaces/<ws>/locations/<n>/` plus a
 * `locations:` list and object channels in `workspace.yaml` (schema v7, phase 1a). Self-contained on purpose:
 * it knows only the LEGACY layout. The bot must be stopped; there is no lock.
 *
 * Apply order per workspace (safest first, so an interrupted run can be finished by a rerun): (1) write the new
 * workspace.yaml (temp + rename) with `locations:` pointing at the FINAL paths, (2) rename each `repos/<n>` to
 * `locations/<n>`, (3) drop the copied `repo.yaml` and the empty `repos/`. If step 2 stops half way, the yaml
 * already lists the location and `repos/<n>` still exists with no clash at `locations/<n>`: the rerun plans just
 * the rename. Each workspace applies inside its own try/catch; one failure never blocks the others.
 */

/** One legacy repo to move. */
export interface RepoMove {
  name: string;
  /** Absolute dir `repos/<n>` and its target `locations/<n>`. */
  from: string;
  to: string;
  /** Absolute location path to store in workspace.yaml (rewritten when it was inside `from`). */
  path: string;
  description: string;
  /** True when workspace.yaml already lists this location with the final path (an interrupted run): only rename. */
  listed?: boolean;
  /** Legacy path before rewriting; set only when it was inside `from` (so it is moved, not copied to backup). */
  insideOld?: string;
  /** `field: value` lines of the dropped legacy fields that were set. */
  dropped: string[];
}

/** Plan and outcome for one workspace. */
export interface WorkspacePlan {
  name: string;
  moves: RepoMove[];
  /** Number of legacy string channels that become objects. */
  channelsConverted: number;
  /** Whether workspace.yaml must be rewritten. */
  writeYaml: boolean;
  /** Entries refused or unreadable, with the reason (never moved). */
  skipped: string[];
  /** Informational lines (a stale `repos/<n>` with no repo.yaml, left alone): never an error. */
  notes: string[];
  /** The raw parsed workspace.yaml (kept so other keys are preserved). */
  data: Record<string, unknown>;
}

/** Result of a run. `backupDir` is set only when `--apply` ran with something to do. */
export interface MigrationReport {
  plans: WorkspacePlan[];
  applied: boolean;
  backupDir?: string;
  /** True when no workspace needs a change (the idempotent second run). */
  nothingToDo: boolean;
  /** Workspaces whose apply threw (the others still ran). */
  failed: { workspace: string; reason: string }[];
}

/** Plan one workspace; null when it has no readable workspace.yaml (not a workspace dir). */
function planWorkspace(home: string, name: string): WorkspacePlan | null {
  const wsRoot = join(home, "workspaces", name);
  const config = join(wsRoot, "workspace.yaml");
  if (!existsSync(config)) return null;
  const skipped: string[] = [];
  let data: Record<string, unknown>;
  try {
    data = (Bun.YAML.parse(readFileSync(config, "utf8")) ?? {}) as Record<string, unknown>;
  } catch {
    return {
      name,
      moves: [],
      channelsConverted: 0,
      writeYaml: false,
      data: {},
      skipped: ["workspace.yaml unreadable"],
      notes: [],
    };
  }
  // An unquoted numeric channel id lost precision when parsed: refuse the whole workspace, the owner quotes it.
  const badChannel = (Array.isArray(data.channels) ? data.channels : []).findIndex(
    (c) => typeof c !== "string" && (typeof c !== "object" || c === null),
  );
  if (badChannel >= 0)
    return {
      name,
      moves: [],
      channelsConverted: 0,
      writeYaml: false,
      data,
      skipped: [`channels[${badChannel}] is not a string id (quote the id in workspace.yaml)`],
      notes: [],
    };
  const reposDir = join(wsRoot, "repos");
  const moves: RepoMove[] = [];
  const notes: string[] = [];
  const listed = new Map(
    (Array.isArray(data.locations) ? data.locations : []).map((l) => [
      (l as { name?: string })?.name,
      (l as { path?: unknown })?.path,
    ]),
  );
  for (const entry of existsSync(reposDir) ? readdirSync(reposDir).sort() : []) {
    const r = planRepo(wsRoot, entry);
    if (typeof r === "string") {
      if (r.startsWith(NOTE)) notes.push(r.slice(NOTE.length));
      else skipped.push(r);
    } else if (!listed.has(r.name)) moves.push(r);
    // Interrupted run: yaml already has this location at the final path and only the rename is left.
    else if (
      typeof listed.get(r.name) === "string" &&
      resolve(wsRoot, listed.get(r.name) as string) === r.path
    )
      moves.push({ ...r, listed: true });
    else skipped.push(`repos/${entry}: location name already in workspace.yaml`);
  }
  const channelsConverted = (Array.isArray(data.channels) ? data.channels : []).filter(
    (c) => typeof c === "string",
  ).length;
  const writeYaml =
    moves.some((m) => !m.listed) || channelsConverted > 0 || !Array.isArray(data.locations);
  return { name, moves, channelsConverted, writeYaml, skipped, notes, data };
}

/** Execute one workspace plan in the safe order (see the file comment): yaml, renames, cleanup. */
function applyWorkspace(home: string, p: WorkspacePlan): void {
  const wsRoot = join(home, "workspaces", p.name);
  if (p.moves.length) mkdirSync(join(wsRoot, "locations"), { recursive: true });
  if (p.writeYaml) writeWorkspaceYaml(home, p);
  for (const m of p.moves) renameSync(m.from, m.to);
  for (const m of p.moves) rmSync(join(m.to, "repo.yaml"), { force: true });
  const reposDir = join(wsRoot, "repos");
  if (existsSync(reposDir) && readdirSync(reposDir).length === 0) rmdirSync(reposDir);
}

/**
 * Plan (and with `apply` execute) the migration for every workspace under `home`. Dry-run touches nothing.
 * With `apply` the backup is written before the first change.
 */
export function migrateLocations(
  home: string,
  opts: { apply: boolean; now?: Date },
): MigrationReport {
  const root = join(home, "workspaces");
  const names = existsSync(root) ? readdirSync(root).sort() : [];
  const plans = names.flatMap((n) => planWorkspace(home, n) ?? []);
  const todo = plans.filter((p) => p.writeYaml || p.moves.length > 0);
  const nothingToDo = todo.length === 0;
  const failed: MigrationReport["failed"] = [];
  if (!opts.apply || nothingToDo) return { plans, applied: false, nothingToDo, failed };
  const ts = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const backupDir = backup(home, todo, ts);
  for (const p of todo) {
    try {
      applyWorkspace(home, p);
    } catch (err) {
      failed.push({ workspace: p.name, reason: (err as Error).message });
    }
  }
  return { plans, applied: true, backupDir, nothingToDo, failed };
}
