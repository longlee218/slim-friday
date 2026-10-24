import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** The places the app itself uses under AGENT_HOME (config, memory and trash belong to the packages that own them). */
export function homePaths(agentHome: string) {
  return {
    home: agentHome,
    /** Folder of the app logs. */
    logs: join(agentHome, "logs"),
    /** Base path of the daily-rolled app log (JSON lines): files are `<base>.<yyyy-MM-dd>.<n>.jsonl`. */
    appLog: () => join(agentHome, "logs", "app"),
    /** Files the owner sent in chat, `inbox/<conversationId>/<epoch ms>/<n>-<name>` (swept after a day). */
    inbox: join(agentHome, "inbox"),
  };
}

/** Create the parent dir of `file` (owner-only) and return `file`. */
export function ensureParentDir(file: string): string {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  return file;
}
