import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { logger } from "../observability/logger";

/** One registered repository the agent may answer questions about. */
export interface Repo {
  name: string;
  /** Absolute path of the clone. */
  path: string;
  /** One-line hint the agent uses to pick the repo. */
  description: string;
}

/** Schema of one `repos.yaml` entry. */
const entrySchema = z.object({
  name: z.string().trim().min(1).regex(/^\S+$/, "no whitespace"), // must be pinnable as repo:<name>
  path: z.string().trim().min(1),
  description: z.string().trim().default(""),
});

/** True when `p` is a directory containing `.git` (dir or worktree file). */
const isGitRepo = (p: string): boolean => {
  try {
    return statSync(p).isDirectory() && existsSync(join(p, ".git"));
  } catch {
    return false;
  }
};

/** Path of the hand-edited registry file. */
export const registryFile = (agentHome: string): string => join(agentHome, "repos.yaml");

/**
 * Load `AGENT_HOME/repos.yaml` (list of {name, path, description}).
 * Invalid entries (bad shape, missing path, not a git repo, duplicate name) are logged and skipped.
 * Returns [] when the file is absent or has no valid repo; the caller tells the owner to add one.
 */
export function loadRepoRegistry(agentHome: string): Repo[] {
  const log = logger.child({ module: "repo-registry" });
  const repos: Repo[] = [];
  const file = registryFile(agentHome);
  if (existsSync(file)) {
    try {
      const raw = Bun.YAML.parse(readFileSync(file, "utf8"));
      for (const item of Array.isArray(raw) ? raw : []) {
        const parsed = entrySchema.safeParse(item);
        if (!parsed.success) {
          log.warn("skipped repo entry with invalid shape");
        } else if (!isGitRepo(parsed.data.path)) {
          log.warn({ name: parsed.data.name }, "skipped repo: path is not a git repo");
        } else if (repos.some((r) => r.name.toLowerCase() === parsed.data.name.toLowerCase())) {
          log.warn({ name: parsed.data.name }, "skipped repo: duplicate name");
        } else {
          repos.push(parsed.data);
        }
      }
    } catch (err) {
      log.warn({ err: String(err) }, "repos.yaml unreadable");
    }
  }
  return repos;
}

/** Split an optional `repo:<name>` prefix off a message. `name` is undefined when absent. */
export function parseRepoPin(text: string): { name?: string; text: string } {
  const m = /^repo:(\S+)\s*/i.exec(text.trim());
  return m ? { name: m[1], text: text.trim().slice(m[0].length) } : { text };
}

/** Prompt block listing the registered repos (only useful with 2+ repos). */
export function buildRegistryContext(repos: Repo[]): string {
  if (repos.length < 2) return "";
  const lines = repos.map(
    (r) => `- ${r.name}: ${r.path}${r.description ? ` — ${r.description}` : ""}`,
  );
  return `Available repos (pick the one that fits the question; search only these paths):\n${lines.join("\n")}`;
}
