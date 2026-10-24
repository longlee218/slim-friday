import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Bot, Group } from "@friday/core";
import { parseBotFile } from "./schemas/bot-file";
import { parseGroupFile } from "./schemas/group-file";

/** The group templates shipped with the repo: `<name>/group.yaml` and `<name>/bots/<id>.md`. */
export const TEMPLATES_DIR = join(import.meta.dir, "..", "templates");

/** Read one template (the group id is the template name). Throws when a file is missing or invalid. */
export function loadTemplate(name: string): { group: Group; bots: Bot[] } {
  const dir = join(TEMPLATES_DIR, name);
  const group = parseGroupFile(name, readFileSync(join(dir, "group.yaml"), "utf8"));
  const botsDir = join(dir, "bots");
  const bots = readdirSync(botsDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => parseBotFile(f.slice(0, -3), readFileSync(join(botsDir, f), "utf8")));
  return { group, bots };
}
