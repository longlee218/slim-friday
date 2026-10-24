import { existsSync, readFileSync } from "node:fs";
import { botFileOf, insideConfig, splitBotFile } from "../admin/config-paths";
import type { DesignContext } from "./design-context";
import { atomicWrite, plainId, Refused, toYaml } from "./design-util";

/**
 * Change the YAML header of an owner bot file and keep its body: `change` edits a copy of the header, the new text is
 * checked with the app's parser, then written in one step. A shipped bot (no file in the owner's dir) or a missing one
 * is refused.
 */
export function editBotHeader(
  ctx: DesignContext,
  id: string,
  change: (header: Record<string, unknown>) => void,
): void {
  const file = botFileOf(ctx.configDir, plainId(id));
  if (!existsSync(file)) throw new Refused(`bot "${id}" is not one of the owner's bots.`, "id");
  const { header, body } = splitBotFile(readFileSync(file, "utf8"));
  const next = { ...header };
  change(next);
  const text = `---\n${toYaml(next)}---\n${body}`;
  try {
    ctx.checkBot(id, text);
  } catch (err) {
    throw new Refused(
      `the bot file is not valid: ${err instanceof Error ? err.message : String(err)}`,
      undefined,
      err,
    );
  }
  atomicWrite(insideConfig(ctx.configDir, file), text);
}
