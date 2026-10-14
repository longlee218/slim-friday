import type { Database } from "bun:sqlite";
import type { Workspace } from "../workspaces/workspace-registry";
import {
  lengthReply,
  type MemoryCommand,
  type MemoryScope,
  splitFirstWord,
} from "./memory-commands";
import { locationTarget, type MemoryTarget, rootTarget, workspaceTarget } from "./memory-targets";

/** Where a command was typed, which decides the scopes it may use. */
export type MemoryPlace = "workspace" | "control";

/** What scope resolution knows about the message. */
export interface ScopeInput {
  db: Database;
  home: string;
  /** Workspace of the channel (absent in the control channel: only `global` is possible there). */
  ws?: Workspace;
  /** Thread the command was typed in; undefined for a plain channel message. */
  threadId?: string;
  place: MemoryPlace;
}

/** Latest task of the thread that had a real location chosen ("*" = none yet). */
function latestTurnLocation(db: Database, threadId: string): string | undefined {
  return db
    .query<{ location: string }, [string]>(
      `SELECT location FROM turns WHERE thread_id = ? AND location != '*'
       ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    )
    .get(threadId)?.location;
}

/** Names of the locations, for refusal texts. */
const names = (ws: Workspace): string => ws.locations.map((r) => `\`${r.name}\``).join(", ");

/**
 * Final scope and text of a forget command in a workspace channel. With the default scope, a first word
 * equal to a location name of the workspace (case-insensitive, NFC) selects that location and is stripped; otherwise it
 * stays plain text. `global`/`chung`/`workspace`/`ws` and `location:<n>` were already taken by the parser, so those
 * words win over a location that happens to share the name. The length rules apply to the text after the strip.
 */
export function refineWriteCommand(
  ws: Workspace | undefined,
  cmd: Extract<MemoryCommand, { kind: "forget" }>,
): { scope: MemoryScope; text: string } | { reply: string } {
  let scope = cmd.scope;
  let text = cmd.needle;
  if (scope.kind === "default" && ws) {
    const { word, tail } = splitFirstWord(text);
    const key = word.normalize("NFC").toLowerCase();
    const hit = ws.locations.find((r) => r.name.normalize("NFC").toLowerCase() === key);
    if (hit) {
      scope = { kind: "location", name: hit.name };
      text = tail;
    }
  }
  const reply = lengthReply(text);
  return reply ? { reply } : { scope, text };
}

/**
 * Turn a scope into one memory file. Names come from the registry only (user text is compared, never joined
 * into a path). Default scope: the location of the thread's latest task, else the
 * workspace's only location; otherwise the owner is asked to name one.
 */
export function resolveMemoryTarget(
  i: ScopeInput,
  scope: MemoryScope,
): MemoryTarget | { reply: string } {
  if (i.place === "control") {
    return scope.kind === "global"
      ? rootTarget(i.home)
      : {
          reply: "In #ops-control only the global memory can be changed: `/forget global <text>`.",
        };
  }
  const { ws } = i;
  if (!ws) return { reply: "This channel is not linked to a workspace." };
  if (scope.kind === "global") return rootTarget(i.home);
  if (scope.kind === "workspace") return workspaceTarget(i.home, ws.name);
  const inWs = (name: string | undefined) => ws.locations.find((r) => r.name === name)?.name;
  if (scope.kind === "location") {
    const hit = ws.locations.find((r) => r.name.toLowerCase() === scope.name.toLowerCase());
    return hit
      ? locationTarget(i.home, ws.name, hit.name)
      : {
          reply: `Unknown location \`${scope.name}\` in workspace ${ws.name}. Locations: ${names(ws)}.`,
        };
  }
  const fromThread = i.threadId ? inWs(latestTurnLocation(i.db, i.threadId)) : undefined;
  const only = ws.locations.length === 1 ? ws.locations[0]?.name : undefined;
  const location = fromThread ?? only;
  return location
    ? locationTarget(i.home, ws.name, location)
    : {
        reply: `Which location? Locations: ${names(ws)}. Write \`/forget <location-name> <text>\` or \`/forget location:<name> <text>\`; \`ws\` = this workspace, \`chung\` = global.`,
      };
}
