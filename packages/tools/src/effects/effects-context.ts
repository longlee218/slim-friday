import type { BotId } from "@friday/core";

/** What the effect tools of one session need from the app. */
export interface EffectsContext {
  botId: BotId;
  /** The bot's workspaces (absolute); effects act only inside them. */
  workspaces: string[];
  /** The agent home (the trash lives in `<home>/trash`). */
  home: string;
  /** True when the real path is a sensitive file (`.env`, keys...) of its workspace. */
  isSensitive(real: string): boolean;
  /** Run a command (argv, no shell) in `cwd`; `out` is stdout and stderr together. */
  run(cmd: string[], cwd: string): Promise<{ code: number; out: string }>;
}
