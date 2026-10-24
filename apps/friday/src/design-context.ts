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
import { sessionScratchDir } from "./session-tools";
import { skillDirs } from "./skills-dirs";

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
  return (spec: BotRuntimeSpec, run: EffectsContext["run"]): DesignContext => ({
    botId: spec.bot.id,
    agentHome,
    configDir: join(agentHome, "config"),
    // The session's own scratch dir (a group session has its own), as the runtime and the chat tools use.
    scratchDir: sessionScratchDir(agentHome, spec),
    botDirs: [join(agentHome, "config", "bots"), join(DEFAULTS_DIR, "bots")],
    skillDirs: skillDirs(agentHome),
    reservedBotIds: RESERVED_BOT_IDS,
    catalogTools: config.toolNames,
    mcpNames: config.mcpNames,
    botSummaries: config.botSummaries,
    groupSummaries: config.groupSummaries,
    nameTaken: config.nameTaken,
    checkBot: (id, text) => void parseBotFile(id, text),
    checkGroup: (id, text) => void parseGroupFile(id, text),
    checkMcp: (text) => void parseMcpFile(text),
    envDenied: isChildEnvDenied,
    // Git runs with hooks and program-running config off, in a clone the bot made itself.
    gitHead: async (dir) => {
      const r = await run(["git", ...GIT_HARDEN, "rev-parse", "HEAD"], dir, GIT_RUN_ENV);
      return r.code === 0 ? r.out.trim() || undefined : undefined;
    },
  });
}
