import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AdminError, OWNER_FILE_MAX_CHARS, type OwnerFile } from "@friday/core";
import type { DesignContext } from "../design/design-context";
import { atomicWrite } from "../design/design-util";
import { insideConfigFile } from "./config-paths";

/** The owner's copy of USER.md or SOUL.md: `<config>/<f>.md`. */
const ownerPath = (ctx: DesignContext, f: OwnerFile): string => join(ctx.configDir, `${f}.md`);

/** The owner's text, else the shipped default (SOUL.md ships, USER.md does not), else an empty string. */
export function readOwnerFile(ctx: DesignContext, f: OwnerFile): string {
  for (const file of [ownerPath(ctx, f), join(ctx.defaultsDir, `${f}.md`)])
    if (existsSync(file)) return readFileSync(file, "utf8");
  return "";
}

/** Write the owner's copy atomically; refused over the size cap or through a symlink out of the config dir. */
export function saveOwnerFile(ctx: DesignContext, f: OwnerFile, text: string): void {
  if (text.length > OWNER_FILE_MAX_CHARS)
    throw new AdminError("BAD_REQUEST", `at most ${OWNER_FILE_MAX_CHARS} characters`, "text");
  atomicWrite(insideConfigFile(ctx.configDir, ownerPath(ctx, f)), text);
}
