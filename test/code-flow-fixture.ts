import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { g, makeLocation } from "./git-fixture";
import { addLocation, clearWorkspaces, defaultLocationPath, makeEnv } from "./helpers";

/**
 * Env with one workspace `main` whose location `real` is a real git clone (a managed clone), with the given extra
 * location.yaml keys (e.g. testCommand). `skills` are curated workspace skills (`workspaces/main/skills/<name>`);
 * `locationSkills` are decoys committed as the location's own `.claude/skills/<name>`, which must never load.
 */
export async function setupWorkflow(
  config: Record<string, string> = {},
  skills: string[] = [],
  locationSkills: string[] = [],
) {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const src = await makeLocation("main");
  const put = (root: string, s: string) => {
    mkdirSync(join(root, s), { recursive: true });
    writeFileSync(join(root, s, "SKILL.md"), `---\nname: ${s}\ndescription: ${s}\n---\nDo ${s}.\n`);
  };
  for (const s of locationSkills) put(join(src.location, ".claude", "skills"), s);
  if (locationSkills.length) {
    await g(src.location, "add", "-A");
    await g(src.location, "commit", "-qm", "skills");
  }
  const clone = defaultLocationPath(env.home, "real", "main");
  addLocation(
    env.home,
    "real",
    { description: "test location", gitAuthor: "Test User <test@example.com>", ...config },
    { path: clone },
  );
  await g(env.home, "clone", "-q", src.location, clone);
  await g(clone, "config", "user.email", "test@example.com");
  await g(clone, "config", "user.name", "t");
  for (const s of skills) put(workspacePaths(env.home).workspace("main").skills, s);
  return { env, clone };
}
