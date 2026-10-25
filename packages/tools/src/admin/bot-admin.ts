import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AdminError, type BotEntry, type BotInput, type GroupEntry } from "@friday/core";
import { deleteBot } from "../design/actions/delete-bot";
import { buildBotFile } from "../design/actions/write-bot";
import type { DesignContext } from "../design/design-context";
import { atomicWrite, plainId } from "../design/design-util";
import { toAdminError } from "./admin-errors";
import { botFileOf, insideConfig, splitBotFile } from "./config-paths";

/** Runs `fn`; whatever the BotDesign checks refuse comes out as an `AdminError`. */
export function guarded<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw toAdminError(err);
  }
}

/** True when the owner's dir has a file for this bot (a shipped bot has none). */
export const isOwnerBot = (ctx: DesignContext, id: string): boolean =>
  existsSync(botFileOf(ctx.configDir, id));

/** True for a shipped bot the owner may override from the web app (Friday): its first edit copies the shipped file. */
const isOverridable = (ctx: DesignContext, id: string): boolean =>
  !isOwnerBot(ctx, id) && !!ctx.ownerBotIds?.includes(id) && ctx.readBotFile(id) !== undefined;

/** Writes the owner's copy of an overridable shipped bot, so later edits keep its avatar, subagents and description. */
function seedOverride(ctx: DesignContext, id: string): void {
  const text = ctx.readBotFile(id);
  if (text !== undefined)
    atomicWrite(insideConfig(ctx.configDir, botFileOf(ctx.configDir, id)), text);
}

/**
 * Throws NOT_FOUND for a bot that does not exist and BAD_REQUEST for a shipped one (read only). Friday is shipped but
 * overridable: it gets the owner's copy here.
 */
export function requireOwnerBot(ctx: DesignContext, id: string): void {
  if (isOwnerBot(ctx, id)) return;
  if (isOverridable(ctx, id)) {
    seedOverride(ctx, id);
    return;
  }
  if (ctx.readBotFile(id) !== undefined)
    throw new AdminError("BAD_REQUEST", "shipped bots are read only", "id");
  throw new AdminError("NOT_FOUND", `bot "${id}" does not exist`, "id");
}

/** One bot as listed: parsed from the bot FILE (header and body), so the instructions carry no SOUL or USER text. */
export function getBotEntry(ctx: DesignContext, rawId: string): BotEntry {
  return guarded(() => {
    const id = plainId(rawId);
    const text = ctx.readBotFile(id);
    if (text === undefined) throw new AdminError("NOT_FOUND", `bot "${id}" does not exist`, "id");
    const { header: h, body } = splitBotFile(text);
    const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
    const opt = <K extends "effort" | "maxEffort" | "autonomy">(k: K) =>
      h[k] === undefined ? {} : { [k]: h[k] as NonNullable<BotInput[K]> };
    return {
      id,
      name: String(h.name ?? ""),
      title: String(h.title ?? ""),
      model: String(h.model ?? ""),
      instructions: body.trim(),
      tools: list(h.tools),
      skills: list(h.skills),
      workspaces: list(h.workspaces),
      ...opt("effort"),
      ...opt("maxEffort"),
      ...opt("autonomy"),
      ...(typeof h.avatar === "string" && { avatar: h.avatar }),
      shipped: !isOwnerBot(ctx, id) && !isOverridable(ctx, id),
    };
  });
}

/** Bots of the owner's dir and the shipped ones, by id (read from disk, so a bot just saved is there). */
export function listBotEntries(ctx: DesignContext): BotEntry[] {
  const ids = new Set<string>();
  for (const dir of ctx.botDirs)
    if (existsSync(dir))
      for (const f of readdirSync(dir)) if (f.endsWith(".md")) ids.add(f.slice(0, -3));
  // One broken file (a YAML typo, an id that is not plain) is left out; it must not lock the whole list.
  return [...ids].sort().flatMap((id) => {
    try {
      return [getBotEntry(ctx, id)];
    } catch {
      return [];
    }
  });
}

/**
 * Create or update an owner bot through the same checks `BotDesign` runs. The avatar and the subagents are not part
 * of the input: an update keeps the file's own. The owner may set autonomy `autonomous`.
 */
export function saveBotFile(ctx: DesignContext, b: BotInput, mode: "create" | "update"): void {
  guarded(() => {
    const id = plainId(b.id);
    if (!isOwnerBot(ctx, id) && ctx.readBotFile(id) !== undefined) {
      if (!isOverridable(ctx, id))
        throw new AdminError("BAD_REQUEST", "shipped bots are read only", "id");
      // The first save of Friday starts from the shipped file; a refused save leaves no copy behind.
      if (mode === "update") {
        seedOverride(ctx, id);
        try {
          return writeBotFile(ctx, b, mode);
        } catch (err) {
          rmSync(botFileOf(ctx.configDir, id), { force: true });
          throw err;
        }
      }
    }
    writeBotFile(ctx, b, mode);
  });
}

/** Checks the input and writes `bots/<id>.md` (the file exists for an update, not for a create). */
function writeBotFile(ctx: DesignContext, b: BotInput, mode: "create" | "update"): void {
  const id = plainId(b.id);
  const exists = isOwnerBot(ctx, id);
  if (mode === "create" && exists)
    throw new AdminError("CONFLICT", `bot "${id}" already exists`, "id");
  if (mode === "update" && !exists)
    throw new AdminError("NOT_FOUND", `bot "${id}" does not exist`, "id");
  const { file, text } = buildBotFile(
    ctx,
    {
      action: "write_bot",
      id: b.id,
      name: b.name,
      title: b.title,
      model: b.model,
      instructions: b.instructions,
      tools: b.tools,
      skills: b.skills,
      workspaces: b.workspaces,
      effort: b.effort,
      maxEffort: b.maxEffort,
      autonomy: b.autonomy,
      overwrite: mode === "update",
    },
    "owner",
  );
  atomicWrite(insideConfig(ctx.configDir, file), text);
}

/** Move an owner bot (file and memory) to the 7-day trash, as `BotDesign` `delete_bot` does; refused while a group has it. */
export function deleteBotFile(ctx: DesignContext, rawId: string, groups: GroupEntry[]): void {
  guarded(() => {
    const id = plainId(rawId);
    if (ctx.reservedBotIds.includes(id))
      throw new AdminError("BAD_REQUEST", `bot "${id}" is reserved and cannot be deleted`, "id");
    requireOwnerBot(ctx, id);
    const inGroups = groups.filter((g) => g.members.includes(id)).map((g) => g.id);
    if (inGroups.length)
      throw new AdminError(
        "CONFLICT",
        `bot "${id}" is in group ${inGroups.join(", ")}; remove it from the group first`,
      );
    insideConfig(ctx.configDir, join(ctx.configDir, "bots", `${id}.md`));
    deleteBot(ctx, { action: "delete_bot", id });
  });
}
