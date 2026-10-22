import type { Database } from "bun:sqlite";
import { adoptThread, isAdopted, recordBotThread } from "../storage/thread-store";
import { loadWorkspaces } from "../workspaces/workspace-registry";

/** Where the handler persists threads and learns which channels are mapped to a space (built in index.ts). */
export interface ThreadsPort {
  /** True when the thread was adopted (owner-made, answered without a mention). */
  isAdopted(threadId: string): boolean;
  /** Persist an adoption (row `origin='adopted'`). */
  adopt(threadId: string, channelId: string): void;
  /** Persist a thread the bot opened, with its placeholder name. */
  recordBotThread(threadId: string, channelId: string, placeholder: string): void;
  /** Workspace and mode of a parent channel mapped to a space; undefined when unmapped. Used for adoption. */
  channelInfo(channelId: string): { workspace: string; mode: "task" | "chat" } | undefined;
}

/**
 * The handler's thread port over the db and the workspaces on disk. Workspaces are re-read per call (like
 * `selectWorkspace`), so a channel added by `/init-channel` works without a restart. An unmapped parent
 * has no `channelInfo`: adoption is refused and a bot thread is stored with an empty workspace.
 */
export function createThreadsPort(db: Database, home: string): ThreadsPort {
  const channelInfo: ThreadsPort["channelInfo"] = (channelId) => {
    for (const w of loadWorkspaces(home).workspaces) {
      const def = w.channelDefs.find((c) => c.id === channelId);
      if (def) return { workspace: w.name, mode: def.mode };
    }
    return undefined;
  };
  return {
    isAdopted: (id) => isAdopted(db, id),
    adopt: (id, channelId) =>
      adoptThread(db, id, channelId, channelInfo(channelId)?.workspace ?? ""),
    recordBotThread: (id, channelId, placeholder) =>
      recordBotThread(db, id, channelId, channelInfo(channelId)?.workspace ?? "", placeholder),
    channelInfo,
  };
}
