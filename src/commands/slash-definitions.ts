import type { SlashName } from "./slash-commands";

/** The one optional/required argument of a native slash command (all commands take at most one). */
interface SlashArg {
  /** Discord option name. */
  name: string;
  description: string;
  required: boolean;
  /** "flag": a boolean that, when true, contributes the option name as the text (e.g. `dry-run`). */
  kind: "string" | "flag";
  /** "usd" values become the legacy `+<usd>` form (`5` and `+5` both work). */
  plus?: boolean;
}

/** One native slash command: name comes from the key of SLASH_DEFINITIONS (typed, so none can be missing). */
interface SlashDefinition {
  description: string;
  arg?: SlashArg;
}

/** Native Discord definitions; `Record<SlashName, ...>` makes the compiler reject a missing or extra command. */
export const SLASH_DEFINITIONS: Record<SlashName, SlashDefinition> = {
  stop: { description: "Stop the run of this thread" },
  status: { description: "Show what the running task is doing" },
  purge: { description: "Empty the trash of this thread's goals now" },
  find: {
    description: "Find threads of this space by keywords",
    arg: { name: "keywords", description: "Words to look for", required: true, kind: "string" },
  },
  go: {
    description: "Start the approved run, optionally raising the budget",
    arg: {
      name: "usd",
      description: "Extra budget in USD",
      required: false,
      kind: "string",
      plus: true,
    },
  },
  remember: {
    description: "Ask the agent to save a memory note",
    arg: { name: "text", description: "What to remember", required: true, kind: "string" },
  },
  forget: {
    description: "Remove a memory note",
    arg: { name: "text", description: "What to forget", required: true, kind: "string" },
  },
  compact: {
    description: "Compact the memory",
    arg: {
      name: "dry-run",
      description: "Only show what would change",
      required: false,
      kind: "flag",
    },
  },
  "init-workspace": {
    description: "Create a workspace (ops control channel only)",
    arg: { name: "name", description: "Workspace name", required: true, kind: "string" },
  },
  "init-channel": {
    description: "Add a private channel to a space (ops control channel only)",
    arg: { name: "path", description: "space/channel", required: true, kind: "string" },
  },
};

/** The payload for the Discord bulk-overwrite call (chat-input commands, usable in guilds only). */
export function slashPayload() {
  return Object.entries(SLASH_DEFINITIONS).map(([name, def]) => ({
    name,
    description: def.description,
    // 1 = CHAT_INPUT; contexts [0] = guild only.
    type: 1,
    contexts: [0],
    options: def.arg
      ? [
          {
            // 5 = BOOLEAN, 3 = STRING
            type: def.arg.kind === "flag" ? 5 : 3,
            name: def.arg.name,
            description: def.arg.description,
            required: def.arg.required,
          },
        ]
      : [],
  }));
}

/** What the user typed, as the `/name arg` text the shared parser (`slashToLegacy`) already understands. */
export function slashText(
  name: string,
  value: (arg: string) => string | number | boolean | null,
): string | null {
  if (!Object.hasOwn(SLASH_DEFINITIONS, name)) return null;
  const def = SLASH_DEFINITIONS[name as SlashName];
  const arg = def.arg;
  const v = arg ? value(arg.name) : null;
  if (!arg || v === null || v === false || v === "") return `/${name}`;
  if (arg.kind === "flag") return `/${name} ${arg.name}`;
  const s = String(v).trim();
  return `/${name} ${arg.plus ? `+${s.replace(/^\+/, "")}` : s}`;
}
