import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { textResult } from "../../../tool-result";
import type { EffectsContext } from "../../effects-context";
import { CREATE_PROJECT_TOOL } from "./constants";
import { CREATE_PROJECT_DESCRIPTION } from "./prompt";

/** A project name: also the dir name, so it is safe as a path segment. */
const PROJECT_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** Input the model sees. */
const SHAPE = { name: z.string().min(1).describe("Project name, e.g. shop-api.") };

/** `CreateProject` for one session; projects go under `projectsDir`. */
export function createCreateProjectTool(ctx: EffectsContext, projectsDir: string) {
  return tool(
    CREATE_PROJECT_TOOL,
    CREATE_PROJECT_DESCRIPTION,
    SHAPE,
    async ({ name }) => {
      if (!PROJECT_NAME.test(name))
        return textResult("Refused: name must match ^[a-z][a-z0-9-]{0,31}$.", true);
      const dir = join(projectsDir, name);
      if (existsSync(dir)) return textResult(`Refused: ${dir} already exists.`, true);
      mkdirSync(dir, { recursive: true });
      const r = await ctx.run(["git", "init"], dir);
      if (r.code !== 0) return textResult(r.out.trim() || "git init failed", true);
      return textResult(dir);
    },
    { annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  );
}
