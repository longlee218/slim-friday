import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { g, makeRepo } from "./git-fixture";
import { addRepo, clearWorkspaces, makeEnv } from "./helpers";

/**
 * Env with one workspace `real` whose repo/ is a real git clone (a managed clone), with the given extra
 * config.yaml keys (e.g. workflow: "full") and optional `.claude/skills/<name>` skills committed in the clone.
 */
export async function setupWorkflow(config: Record<string, string> = {}, skills: string[] = []) {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const src = await makeRepo("main");
  for (const s of skills) {
    const d = join(src.repo, ".claude", "skills", s);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "SKILL.md"), `---\nname: ${s}\ndescription: ${s}\n---\nDo ${s}.\n`);
  }
  if (skills.length) {
    await g(src.repo, "add", "-A");
    await g(src.repo, "commit", "-qm", "skills");
  }
  const clone = workspacePaths(env.home).workspace("main").repo("real").clone;
  addRepo(
    env.home,
    "real",
    { description: "test repo", gitAuthor: "Test User <test@example.com>", ...config },
    { path: clone },
  );
  await g(env.home, "clone", "-q", src.repo, clone);
  await g(clone, "config", "user.email", "test@example.com");
  await g(clone, "config", "user.name", "t");
  return { env, clone };
}
