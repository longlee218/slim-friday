import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startWorktree } from "../src/workspaces/task-clone";
import { g, makeRepo } from "./git-fixture";
import { addRepo, clearWorkspaces, makeEnv } from "./helpers";

/** Test-only: a real owner repo (no origin unless `origin`) registered in workspace `main`, and a way to start task clones of it. */
export async function cloneEnv(origin?: string) {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const src = await makeRepo("main");
  if (origin) await g(src.repo, "remote", "add", "origin", origin);
  addRepo(env.home, "ext", { gitAuthor: "Test User <test@example.com>" }, { path: src.repo });
  const repo = { name: "ext", path: src.repo, gitAuthor: "Test User <test@example.com>" } as never;
  const deps = { db: env.db, config: env.config } as never;
  /** Start a clone for `taskId` (a UUID); throws when refused. */
  const start = async (taskId: string, threadId = "th") => {
    const r = await startWorktree(
      deps,
      { taskId, threadId, workspace: "main", text: "add b", ac: new AbortController() } as never,
      repo,
      "plan",
    );
    if (!("wt" in r)) throw new Error(r.text);
    return r.wt;
  };
  /** Commit `name` with `content` inside a clone. */
  const commit = async (path: string, name: string, content: string) => {
    writeFileSync(join(path, name), content);
    await g(path, "add", name);
    await g(path, "commit", "-qm", `add ${name}`);
  };
  return { env, src, repo, deps, start, commit };
}

/** A task id from a short hex prefix (UUID shape). */
export const tid = (hex8: string, n = 1): string =>
  `${hex8}-1111-2222-3333-${String(n).padStart(12, "0")}`;
