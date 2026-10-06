import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { AgentConfig } from "../config/agent-config";
import { workspacePaths } from "../config/workspace-paths";
import type { GitIdentity } from "../mcp/git-mcp";
import { logger } from "../observability/logger";
import { errText } from "../observability/redact";

/** One registered repository the agent may answer questions about. */
export interface Repo {
  /** Workspace directory name. */
  name: string;
  /** Absolute path of the workspace directory. */
  workspace: string;
  /** Absolute path of the repo (the workspace clone, or any other git working copy). */
  path: string;
  /** One-line hint the agent uses to pick the repo. */
  description: string;
  /** Branch worktrees are cut from (default "main"). */
  defaultBranch?: string;
  /** Shell command the agent runs to test changes in this repo. */
  testCommand?: string;
  /** `gh` login whose token opens PRs for this repo; active gh account when absent. */
  githubAccount?: string;
  /** Commit identity `Name <email>`; agent commits are made as this user, never the global git user. */
  gitAuthor?: string;
}

/** Schema of a workspace `config.yaml` (the repo name is the workspace directory name). */
const configSchema = z.object({
  /** Where the agent reads the repo; default `<workspace>/repo` (the managed clone code tasks need). */
  path: z.string().trim().min(1).optional(),
  description: z.string().trim().default(""),
  defaultBranch: z.string().trim().min(1).optional(),
  testCommand: z.string().trim().min(1).optional(),
  githubAccount: z.string().trim().min(1).optional(),
  gitAuthor: z.string().trim().min(1).optional(),
});

/** Workspace directory names double as `repo:<name>` pins: no whitespace. */
const NAME_RE = /^[\w.-]+$/;

/** True when `p` is a directory containing `.git` (dir or worktree file). */
const isGitRepo = (p: string): boolean => {
  try {
    return statSync(p).isDirectory() && existsSync(join(p, ".git"));
  } catch {
    return false;
  }
};

/**
 * Registry = every `AGENT_HOME/workspaces/<name>/config.yaml` (OpenClaw-style: one workspace per repo).
 * A workspace with a bad config, a missing path or a non-git path is logged and skipped.
 * Returns [] when there is none; the caller tells the owner to add one.
 */
export function loadRepoRegistry(agentHome: string): Repo[] {
  const log = logger.child({ module: "repo-registry" });
  const paths = workspacePaths(agentHome);
  const repos: Repo[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(paths.workspaces, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name)
      .sort();
  } catch {
    return repos; // no workspaces dir yet
  }
  for (const name of names) {
    const ws = paths.workspace(name);
    if (!existsSync(ws.config)) continue; // not a workspace (no config.yaml)
    if (!NAME_RE.test(name)) {
      log.warn({ name }, "skipped workspace: name must have no whitespace");
      continue;
    }
    try {
      const parsed = configSchema.safeParse(Bun.YAML.parse(readFileSync(ws.config, "utf8")) ?? {});
      if (!parsed.success) {
        log.warn({ name }, "skipped workspace: invalid config.yaml");
        continue;
      }
      const path = parsed.data.path ? resolve(ws.root, parsed.data.path) : ws.repo;
      if (!isGitRepo(path)) {
        log.warn({ name }, "skipped workspace: path is not a git repo");
        continue;
      }
      repos.push({ name, workspace: ws.root, ...parsed.data, path });
    } catch (err) {
      log.warn({ name, err: errText(err) }, "skipped workspace: config.yaml unreadable");
    }
  }
  return repos;
}

/** Prompt block listing the registered repos (only useful with 2+ repos). */
export function buildRegistryContext(repos: Repo[], force = false): string {
  if (repos.length < 2 && !force) return "";
  const lines = repos.map((r) => {
    // Repo instructions only auto-load when the repo is the cwd: point the agent at them otherwise.
    const claude = join(r.path, "CLAUDE.md");
    const hint = existsSync(claude) ? ` [read ${claude} first]` : "";
    return `- ${r.name}: ${r.path}${r.description ? ` — ${r.description}` : ""}${hint}`;
  });
  return `Available repos (pick the one that fits the question; search only these paths):\n${lines.join("\n")}`;
}

/**
 * Parse `Name <email>`; null when malformed. Deliberately strict: the git MCP server refuses to start
 * with a name under 2 chars or an email without a 2+ letter domain suffix, and then the agent has no git tools.
 */
export function parseAuthor(text: string | undefined): GitIdentity | null {
  const m = /^\s*(.{2,}?)\s*<([^<>\s@]+@[^<>\s@]+\.[A-Za-z]{2,})>\s*$/.exec(text ?? "");
  return m ? { name: m[1]!, email: m[2]! } : null;
}

/** Commit identity for a repo: its own `gitAuthor` (config.yaml), else the global GIT_AUTHOR env. Null = not configured. */
export function resolveAuthor(repo: Repo, config: AgentConfig): GitIdentity | null {
  return parseAuthor(repo.gitAuthor) ?? parseAuthor(config.gitAuthor);
}
