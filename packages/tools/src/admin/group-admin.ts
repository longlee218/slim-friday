import { existsSync, readdirSync, readFileSync } from "node:fs";
import { AdminError, type GroupEntry, type GroupInput } from "@friday/core";
import { buildGroupFile } from "../design/actions/write-group";
import type { DesignContext } from "../design/design-context";
import { atomicWrite, plainId, Refused, toYaml } from "../design/design-util";
import { moveToTrash } from "../effects/trash-store";
import { guarded } from "./bot-admin";
import { groupFileOf, insideConfig } from "./config-paths";

/** The parsed YAML of an owner group file; NOT_FOUND when there is none. */
function readGroupYaml(ctx: DesignContext, id: string): Record<string, unknown> {
  const file = groupFileOf(ctx.configDir, id);
  if (!existsSync(file)) throw new AdminError("NOT_FOUND", `group "${id}" does not exist`, "id");
  return (Bun.YAML.parse(readFileSync(file, "utf8")) as Record<string, unknown> | null) ?? {};
}

/** One group as listed. */
export function getGroupEntry(ctx: DesignContext, rawId: string): GroupEntry {
  return guarded(() => {
    const id = plainId(rawId);
    const g = readGroupYaml(ctx, id);
    const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
    return {
      id,
      name: String(g.name ?? ""),
      members: list(g.members),
      entryBot: String(g.entryBot ?? ""),
      workspaces: list(g.workspaces),
      instructions: typeof g.instructions === "string" ? g.instructions : "",
      ...(typeof g.avatar === "string" && { avatar: g.avatar }),
    };
  });
}

/** Every group file of the owner's dir, by id (read from disk, so a group just saved is there). */
export function listGroupEntries(ctx: DesignContext): GroupEntry[] {
  const dir = `${ctx.configDir}/groups`;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => f.slice(0, -5))
    .sort()
    .flatMap((id) => {
      // One broken file is left out; it must not lock the list or the bot delete check.
      try {
        return [getGroupEntry(ctx, id)];
      } catch {
        return [];
      }
    });
}

/** Create or update a group through the same checks `BotDesign` runs; an update keeps the file's avatar. */
export function saveGroupFile(ctx: DesignContext, g: GroupInput, mode: "create" | "update"): void {
  guarded(() => {
    const id = plainId(g.id);
    const exists = existsSync(groupFileOf(ctx.configDir, id));
    if (mode === "create" && exists)
      throw new AdminError("CONFLICT", `group "${id}" already exists`, "id");
    if (mode === "update" && !exists)
      throw new AdminError("NOT_FOUND", `group "${id}" does not exist`, "id");
    const { file, text } = buildGroupFile(ctx, {
      action: "write_group",
      id: g.id,
      name: g.name,
      members: g.members,
      entryBot: g.entryBot,
      workspaces: g.workspaces,
      instructions: g.instructions,
      overwrite: mode === "update",
    });
    atomicWrite(insideConfig(ctx.configDir, file), text);
  });
}

/** Move a group file (and its memory) to the 7-day trash, the same helper `delete_bot` uses. */
export function deleteGroupFile(ctx: DesignContext, rawId: string): void {
  guarded(() => {
    const id = plainId(rawId);
    // Existence only: a group file that does not parse can still be deleted.
    if (!existsSync(groupFileOf(ctx.configDir, id)))
      throw new AdminError("NOT_FOUND", `group "${id}" does not exist`, "id");
    const file = insideConfig(ctx.configDir, groupFileOf(ctx.configDir, id));
    const memoryDir = ctx.memory.dirOf({ kind: "group", groupId: id });
    const paths = existsSync(memoryDir) ? [file, memoryDir] : [file];
    const move = moveToTrash(ctx.agentHome, ctx.botId, paths, ctx.now());
    if (move.error)
      throw new Error(
        `trash move stopped (${move.error}) after ${move.entries.length} of ${paths.length}; moved: ${move.entries.map((e) => e.from).join(", ") || "none"}.`,
      );
  });
}

/** Set or clear the avatar of a group file; returns the value it replaced. */
export function setGroupAvatar(
  ctx: DesignContext,
  id: string,
  avatar: string | null,
): { previous?: string } {
  const g = readGroupYaml(ctx, id);
  const previous = typeof g.avatar === "string" ? g.avatar : undefined;
  const { avatar: _old, ...rest } = g;
  const text = toYaml(avatar === null ? rest : { ...rest, avatar });
  try {
    ctx.checkGroup(id, text);
  } catch (err) {
    throw new Refused(
      `the group file is not valid: ${err instanceof Error ? err.message : String(err)}`,
      undefined,
      err,
    );
  }
  atomicWrite(insideConfig(ctx.configDir, groupFileOf(ctx.configDir, id)), text);
  return previous === undefined ? {} : { previous };
}
