import { readFileSync } from "node:fs";
import { z } from "zod";
import { workspacePaths } from "../config/workspace-paths";
import { logger } from "../observability/logger";

const log = logger.child({ module: "skills-config" });

/** Name of a skill set (a directory under `vendor/skill-sets/`): lowercase-hyphen, no path characters. */
export const SKILL_SET_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * `skills` block of workspace.yaml. Skill SETS belong to the role (data), not the workspace. Unknown keys (an old
 * `sets` or `mode`) are ignored, never an error.
 */
export const workspaceSkillsSchema = z
  .object({
    /** Also load the workspace's own `skills/` dir. */
    extra: z.boolean().default(true),
  })
  .default({ extra: true });

export type SkillsConfig = z.infer<typeof workspaceSkillsSchema>;

/** The `skills` block of `workspaces/<ws>/workspace.yaml`; the defaults when the file or block is missing or invalid. */
export function readWorkspaceSkills(agentHome: string, workspace: string): SkillsConfig {
  const fallback = workspaceSkillsSchema.parse(undefined);
  try {
    const data = Bun.YAML.parse(
      readFileSync(workspacePaths(agentHome).workspace(workspace).config, "utf8"),
    ) as { skills?: unknown } | null;
    const parsed = workspaceSkillsSchema.safeParse(data?.skills);
    if (!parsed.success)
      log.warn({ workspace }, "invalid skills block in workspace.yaml: defaults");
    return parsed.success ? parsed.data : fallback;
  } catch (err) {
    // A missing file is normal (tests, a half-made workspace); anything else is worth a warn.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn({ workspace, err: String(err) }, "workspace.yaml unreadable: skills defaults");
    }
    return fallback;
  }
}
