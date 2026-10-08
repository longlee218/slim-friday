import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { z } from "zod";
import { isWorkspaceName, workspacePaths } from "../config/workspace-paths";
import { isInside } from "../guardrails/paths";
import { logEvent, logger } from "../observability/logger";
import { errText } from "../observability/redact";
import { isRealDir, loadRepos, type Repo, real } from "../repos/repo-registry";

/** One workspace: a group of repos behind one set of Discord channels. */
export interface Workspace {
  /** Directory name under `workspaces/` (lowercase-hyphen). */
  name: string;
  /** Absolute path of the workspace directory. */
  root: string;
  /** Free-text hint about what the workspace is for. */
  description: string;
  /** Discord parent-channel ids routed to this workspace (each id belongs to exactly one workspace). */
  channels: string[];
  /** Valid repos of the workspace. */
  repos: Repo[];
}

/** Result of a scan: loaded workspaces plus pre-Step-B per-repo dirs that were found but never loaded. */
export interface WorkspaceScan {
  workspaces: Workspace[];
  /** Names of legacy dirs (`config.yaml` and no `workspace.yaml`): a migration is needed. */
  legacy: string[];
}

/** Schema of `workspace.yaml`: no `default` key, channels are Discord snowflakes. */
const workspaceSchema = z.object({
  description: z.string().trim().optional(),
  channels: z.array(z.string().regex(/^\d{17,20}$/)).default([]),
});

/** Drop channel ids that two workspaces both list (from both: routing must never be ambiguous). */
function dropDuplicateChannels(workspaces: Workspace[]): void {
  const owners = new Map<string, number>();
  for (const w of workspaces)
    for (const c of new Set(w.channels)) owners.set(c, (owners.get(c) ?? 0) + 1);
  const dup = [...owners].filter(([, n]) => n > 1).map(([c]) => c);
  if (!dup.length) return;
  logEvent(
    logger.child({ module: "workspace-registry" }),
    "channel.duplicate",
    { channels: dup },
    "warn",
  );
  for (const w of workspaces) w.channels = w.channels.filter((c) => !dup.includes(c));
}

/** Warn (not skip) when repo paths of different workspaces are equal or nested. */
function warnOverlap(workspaces: Workspace[]): void {
  const all = workspaces.flatMap((w) => w.repos.map((r) => ({ r, p: real(r.path) })));
  for (const [i, a] of all.entries()) {
    for (const b of all.slice(i + 1)) {
      if (a.r.workspace === b.r.workspace || !(isInside(a.p, b.p) || isInside(b.p, a.p))) continue;
      const fields = { a: `${a.r.workspace}/${a.r.name}`, b: `${b.r.workspace}/${b.r.name}` };
      logEvent(logger.child({ module: "workspace-registry" }), "repo.overlap", fields, "warn");
    }
  }
}

/**
 * Scan `AGENT_HOME/workspaces/*`. A dir counts as a workspace when it is a real dir (not a symlink) with a
 * valid name and a valid `workspace.yaml`; anything else is warned about and skipped (fail closed).
 * Repos must be git roots that do not cover `userHome` (the owner's $HOME) or AGENT_HOME.
 */
export function loadWorkspaces(agentHome: string, userHome = homedir()): WorkspaceScan {
  const log = logger.child({ module: "workspace-registry" });
  const paths = workspacePaths(agentHome);
  const out: WorkspaceScan = { workspaces: [], legacy: [] };
  let names: string[] = [];
  try {
    names = readdirSync(paths.workspaces).sort();
  } catch {
    return out; // no workspaces dir yet
  }
  // $HOME env can differ from os.homedir() / userHome: forbid both.
  const forbidden = [userHome, agentHome, ...(process.env.HOME ? [process.env.HOME] : [])];
  for (const name of names) {
    const legacy = paths.legacyWorkspace(name);
    const ws = paths.workspace(name);
    if (!isRealDir(ws.root)) continue;
    if (!existsSync(ws.config)) {
      if (existsSync(legacy.config)) out.legacy.push(name); // old layout: listed, never loaded
      continue;
    }
    if (!isWorkspaceName(name)) {
      log.warn({ name }, "skipped workspace: bad name");
      continue;
    }
    try {
      const parsed = workspaceSchema.safeParse(
        Bun.YAML.parse(readFileSync(ws.config, "utf8")) ?? {},
      );
      if (!parsed.success) {
        log.warn({ name }, "skipped workspace: invalid workspace.yaml");
        continue;
      }
      const { description = "", channels } = parsed.data;
      out.workspaces.push({
        name,
        root: ws.root,
        description,
        channels,
        repos: loadRepos(ws, forbidden),
      });
    } catch (err) {
      log.warn({ name, err: errText(err) }, "skipped workspace: workspace.yaml unreadable");
    }
  }
  dropDuplicateChannels(out.workspaces);
  warnOverlap(out.workspaces);
  return out;
}

/**
 * Every repo of every workspace, flat. TODO(1b): flows are still per-repo-name; they will take the
 * workspace the channel routes to instead of this union.
 */
export function loadRepoRegistry(agentHome: string): Repo[] {
  return loadWorkspaces(agentHome).workspaces.flatMap((w) => w.repos);
}
