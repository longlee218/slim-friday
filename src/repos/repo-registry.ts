import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { REPO_NAME, type WorkspacePaths } from "../config/workspace-paths";
import { isInside } from "../guardrails/paths";
import { logger } from "../observability/logger";
import { errText } from "../observability/redact";

/** One registered repository the agent may answer questions about. */
export interface Repo {
  /** Repo directory name (unique inside its workspace). */
  name: string;
  /** Name of the workspace that owns the repo. */
  workspace: string;
  /** Absolute path of the repo directory `workspaces/<ws>/repos/<name>` (repo.yaml, MEMORY.md, worktrees). */
  dir: string;
  /** Absolute path of the repo (the workspace clone, or any other git working copy). */
  path: string;
  /** One-line hint the agent uses to pick the repo. */
  description: string;
  /** Default branch of the repo (default "main"); the agent decides what to branch from. */
  defaultBranch?: string;
  /** Shell command the agent runs to test changes in this repo. */
  testCommand?: string;
  /** How exec stages run here: `lean` (default, app plan -> exec) or `full` (the repo's own workflow and skills, autonomous). */
  workflow?: Workflow;
}

/** Per-repo workflow of exec stages. */
export type Workflow = "lean" | "full";

/** Paths of one workspace (`workspacePaths(home).workspace(name)`). */
export type WorkspaceDirs = ReturnType<WorkspacePaths["workspace"]>;

/** Schema of a `repo.yaml` (the repo name is its directory name). */
const configSchema = z.object({
  /** Where the agent reads the repo; default `<repo dir>/repo` (the managed clone staged tasks need). */
  path: z.string().trim().min(1).optional(),
  description: z.string().trim().default(""),
  defaultBranch: z.string().trim().min(1).optional(),
  testCommand: z.string().trim().min(1).optional(),
  // Accepted and IGNORED since Rev 15 (the agent commits and opens PRs with the owner's own git config and `gh` login).
  githubAccount: z.string().trim().min(1).optional(),
  gitAuthor: z.string().trim().min(1).optional(),
  workflow: z.enum(["lean", "full"]).default("lean"),
});

/** True when `p` is a directory containing `.git` (dir or worktree file). */
const isGitRepo = (p: string): boolean => {
  try {
    return statSync(p).isDirectory() && existsSync(join(p, ".git"));
  } catch {
    return false;
  }
};

/** Real path, or the input when it does not resolve (the one shared helper). */
export const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** True when `p` is a real directory (a symlink to one does not count). */
export function isRealDir(p: string): boolean {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Repos of one workspace = every `repos/<name>/repo.yaml`. A repo with a bad name, a symlinked dir, a bad
 * config, a path that is not a git root, or a path that is/contains one of `forbidden` (the owner's $HOME,
 * AGENT_HOME) is logged and skipped. Returns [] when there is none.
 */
export function loadRepos(ws: WorkspaceDirs, forbidden: string[] = []): Repo[] {
  const log = logger.child({ module: "repo-registry" });
  const wsName = basename(ws.root);
  const repos: Repo[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(ws.repos).sort();
  } catch {
    return repos; // no repos dir yet
  }
  for (const name of names) {
    const rp = ws.repo(name);
    if (!isRealDir(rp.root)) continue; // not a dir (or a symlink): never followed
    if (!REPO_NAME.test(name)) {
      log.warn({ workspace: wsName, name }, "skipped repo: bad name");
      continue;
    }
    if (!existsSync(rp.config)) continue; // not a repo (no repo.yaml)
    try {
      const parsed = configSchema.safeParse(Bun.YAML.parse(readFileSync(rp.config, "utf8")) ?? {});
      if (!parsed.success) {
        log.warn({ workspace: wsName, name }, "skipped repo: invalid repo.yaml");
        continue;
      }
      const path = parsed.data.path ? resolve(rp.root, parsed.data.path) : rp.clone;
      if (!isGitRepo(path)) {
        log.warn({ workspace: wsName, name }, "skipped repo: path is not a git root");
        continue;
      }
      const rpath = real(path);
      if (forbidden.some((f) => isInside(rpath, real(f)))) {
        log.warn({ workspace: wsName, name }, "skipped repo: path covers the home dir");
        continue;
      }
      repos.push({ name, workspace: wsName, dir: rp.root, ...parsed.data, path });
    } catch (err) {
      log.warn(
        { workspace: wsName, name, err: errText(err) },
        "skipped repo: repo.yaml unreadable",
      );
    }
  }
  return repos;
}

/** Prompt block listing the repos of workspace `ws` (only useful with 2+ repos). */
export function buildRegistryContext(ws: string, repos: Repo[], force = false): string {
  if (repos.length < 2 && !force) return "";
  const lines = repos.map((r) => {
    const flow = r.workflow === "full" ? " [workflow: full]" : "";
    return `- ${r.name}: ${r.path}${r.description ? ` — ${r.description}` : ""}${flow}`;
  });
  return `Available repos in workspace ${ws} (pick the one that fits the question; search only these paths):\n${lines.join("\n")}`;
}
