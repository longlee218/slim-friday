import type { AdminContext } from "../../../mcp/manifest-types";
import type { InitDeps } from "./init-workspace";

export type { ConfirmQuestion } from "../../../mcp/manifest-types";

/**
 * What the tools of the in-process `discord-admin` server need about the run they belong to. Built per run by the
 * control-channel runner: the agent never holds a Discord token, only these tools reach Discord and the space files.
 */
export interface DiscordAdminContext extends AdminContext {
  /** Pinned guild + ids of the creation helpers (`initWorkspace` / `initChannel`). */
  init: InitDeps;
}
