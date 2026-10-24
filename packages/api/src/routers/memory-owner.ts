import type { MemoryOwner } from "@friday/core";
import { ORPCError } from "@orpc/server";
import type { ApiDeps } from "../app";

/**
 * Turns the wire owner (`bot:<id>` / `group:<id>`, shape already checked by the contract) into
 * the core owner. An id that is no configured bot or group answers `NOT_FOUND`.
 */
export function parseOwner(deps: ApiDeps, owner: string): MemoryOwner {
  const sep = owner.indexOf(":");
  const kind = owner.slice(0, sep);
  const id = owner.slice(sep + 1);
  const { config } = deps.settings;
  const known = (kind === "bot" ? config.listBots() : config.listGroups()).some((e) => e.id === id);
  if (!known) throw new ORPCError("NOT_FOUND", { message: `no ${kind} ${id}` });
  return kind === "bot" ? { kind: "bot", botId: id } : { kind: "group", groupId: id };
}
