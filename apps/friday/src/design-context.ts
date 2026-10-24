import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULTS_DIR,
  type FileConfig,
  parseBotFile,
  parseGroupFile,
  parseMcpFile,
  RESERVED_BOT_IDS,
} from "@friday/config";
import type { BotRuntimeSpec } from "@friday/core";
import { isChildEnvDenied } from "@friday/runtime-claude";
import { type DesignContext, type EffectsContext, GIT_HARDEN, GIT_RUN_ENV } from "@friday/tools";
import { AVATARS_DIR } from "./avatars";
import { sessionScratchDir } from "./session-tools";
import { skillDirs } from "./skills-dirs";

/** The design context without what the session tools add (the bots' memory, the review views, the messages). */
export type DesignContextBase = Omit<DesignContext, "memory" | "insight" | "messages">;

/** What the design tools of every session are made from. */
export interface DesignDeps {
  config: FileConfig;
  agentHome: string;
}

/**
 * The context of `BotDesign` and `BotLookup` for one session: the owner's config dir is the only place they write, and
 * the app's own parsers decide whether a bot, group or MCP file is valid. `run` is the effect tools' command runner.
 */
export function designContextFor(deps: DesignDeps) {
  const { config, agentHome } = deps;
  return (spec: BotRuntimeSpec, run: EffectsContext["run"]): DesignContextBase => ({
    botId: spec.bot.id,
    agentHome,
    configDir: join(agentHome, "config"),
    // The session's own scratch dir (a group session has its own), as the runtime and the chat tools use.
    scratchDir: sessionScratchDir(agentHome, spec),
    defaultsDir: DEFAULTS_DIR,
    botDirs: [join(agentHome, "config", "bots"), join(DEFAULTS_DIR, "bots")],
    skillDirs: skillDirs(agentHome),
    reservedBotIds: RESERVED_BOT_IDS,
    catalogTools: config.toolNames,
    mcpNames: config.mcpNames,
    botSummaries: config.botSummaries,
    groupSummaries: config.groupSummaries,
    nameTaken: config.nameTaken,
    // The shipped avatars and the owner's own (`config/avatars/<name>.png`).
    presetAvatars: () => [
      ...new Set(
        [AVATARS_DIR, join(agentHome, "config", "avatars")].flatMap((d) =>
          existsSync(d)
            ? readdirSync(d)
                .filter((f) => f.endsWith(".png"))
                .map((f) => f.slice(0, -4))
            : [],
        ),
      ),
    ],
    // The owner's bot file first, then the shipped one.
    readBotFile: (id) => {
      const dirs = [join(agentHome, "config", "bots"), join(DEFAULTS_DIR, "bots")];
      const file = dirs.map((d) => join(d, `${id}.md`)).find((f) => existsSync(f));
      return file ? readFileSync(file, "utf8") : undefined;
    },
    checkBot: (id, text) => void parseBotFile(id, text),
    checkGroup: (id, text) => void parseGroupFile(id, text),
    checkMcp: (text) => void parseMcpFile(text),
    envDenied: isChildEnvDenied,
    // Git runs with hooks and program-running config off, in a clone the bot made itself.
    now: () => Date.now(),
    gitHead: async (dir) => {
      const r = await run(["git", ...GIT_HARDEN, "rev-parse", "HEAD"], dir, GIT_RUN_ENV);
      return r.code === 0 ? r.out.trim() || undefined : undefined;
    },
  });
}
