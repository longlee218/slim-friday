import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { g, makeRepo } from "./git-fixture";
import { addRepo, clearWorkspaces, makeEnv } from "./helpers";

/**
 * Env with one workspace `main` whose repo `real` is a real git clone (a managed clone), with the given extra
 * repo.yaml keys (e.g. workflow: "full"). `skills` are curated workspace skills (`workspaces/main/skills/<name>`);
 * `repoSkills` are decoys committed as the repo's own `.claude/skills/<name>`, which must never load.
 */
export async function setupWorkflow(
  config: Record<string, string> = {},
  skills: string[] = [],
  repoSkills: string[] = [],
) {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const src = await makeRepo("main");
  const put = (root: string, s: string) => {
    mkdirSync(join(root, s), { recursive: true });
    writeFileSync(join(root, s, "SKILL.md"), `---\nname: ${s}\ndescription: ${s}\n---\nDo ${s}.\n`);
  };
  for (const s of repoSkills) put(join(src.repo, ".claude", "skills"), s);
  if (repoSkills.length) {
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
  for (const s of skills) put(workspacePaths(env.home).workspace("main").skills, s);
  return { env, clone };
}
