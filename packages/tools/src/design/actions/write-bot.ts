import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { DesignArgs } from "../design-args";
import type { DesignContext } from "../design-context";
import {
  atomicWrite,
  existingSubagents,
  listSkills,
  need,
  plainId,
  Refused,
  toYaml,
} from "../design-util";

/** True when the tool name is in the catalog, or names an MCP server the app knows (whole server or one tool). */
function toolKnown(ctx: DesignContext, tool: string, catalog: Set<string>): boolean {
  if (catalog.has(tool)) return true;
  const m = /^mcp__([a-z][a-z0-9-]*)(?:__.+)?$/.exec(tool);
  return !!m && ctx.mcpNames().includes(m[1] ?? "");
}

/** A workspace must be an absolute, existing dir outside the agent home. */
function checkWorkspace(ctx: DesignContext, ws: string): void {
  if (!isAbsolute(ws)) throw new Refused(`workspace must be an absolute path: ${ws}`);
  try {
    if (!statSync(ws).isDirectory()) throw new Error();
  } catch {
    throw new Refused(`workspace is not an existing dir: ${ws}`);
  }
  const r = relative(ctx.agentHome, ws);
  if (r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r)))
    throw new Refused(`workspace is inside the agent home: ${ws}`);
}

/** `write_bot`: validate, render `bots/<id>.md`, check it with the app's parser, then write it. */
export function writeBot(ctx: DesignContext, a: DesignArgs): string {
  const id = plainId(a.id);
  if (ctx.reservedBotIds.includes(id)) throw new Refused(`bot id "${id}" is reserved.`);
  const name = need(a.name, "name");
  const body = need(a.instructions, "instructions");
  // Autonomy `autonomous` runs write and external tools without asking and beats settings.yaml: the owner sets it by hand.
  if (a.autonomy === "autonomous")
    throw new Refused("autonomy autonomous is for the owner to set by hand.");
  const catalog = new Set(ctx.catalogTools());
  // A repeated name only pads the approval card, which is cut at a fixed length.
  if (new Set(a.tools).size !== (a.tools ?? []).length)
    throw new Refused("tools lists a name twice.");
  for (const t of a.tools ?? []) {
    // The design tools belong to the Friday bot only.
    if (t === "mcp__design" || t.startsWith("mcp__design__"))
      throw new Refused("the design tools cannot be given to another bot.");
    if (!toolKnown(ctx, t, catalog)) throw new Refused(`unknown tool: ${t} (see BotLookup list).`);
  }
  const known = new Set(listSkills(ctx.skillDirs).map((s) => s.name));
  for (const s of a.skills ?? [])
    if (!known.has(s)) throw new Refused(`unknown skill: ${s} (see BotLookup list).`);
  for (const w of a.workspaces ?? []) checkWorkspace(ctx, w);
  if (ctx.nameTaken(name, id))
    throw new Refused(`the name "${name}" is already used by another bot.`);
  const file = join(ctx.configDir, "bots", `${id}.md`);
  if (existsSync(file) && !a.overwrite)
    throw new Refused(
      `bot "${id}" already exists; ask the owner, then call again with overwrite: true.`,
    );
  const subagents = existingSubagents(file);
  const header = {
    name,
    title: need(a.title, "title"),
    model: need(a.model, "model"),
    tools: a.tools ?? [],
    skills: a.skills ?? [],
    workspaces: a.workspaces ?? [],
    ...(subagents.length > 0 && { subagents }),
    ...(a.autonomy && { autonomy: a.autonomy }),
    ...(a.avatar && { avatar: a.avatar }),
  };
  const text = `---\n${toYaml(header)}---\n${body}\n`;
  try {
    ctx.checkBot(id, text);
  } catch (err) {
    throw new Refused(
      `the bot file is not valid: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  atomicWrite(file, text);
  return `Wrote bot ${id}. Its channel appears in a few seconds.`;
}
