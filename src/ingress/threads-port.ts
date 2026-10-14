import type { Database } from "bun:sqlite";
import { adoptThread, isAdopted, recordBotThread } from "../storage/thread-store";
import { loadWorkspaces } from "../workspaces/workspace-registry";
import type { ThreadsPort } from "./thread-placement";

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
