import { ROLES } from "../roles/role-registry";
import { PLAN_HISTORY_ARG, type SlashName } from "./slash-commands";

/** The one optional/required argument of a native slash command (all commands take at most one). */
interface SlashArg {
  /** Discord option name. */
  name: string;
  description: string;
  required: boolean;
  /** Fixed values the Discord picker offers (the value typed is then one of them). */
  choices?: string[];
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
  limits: {
    description: "Show every limit, budget and stop condition (private reply)",
    arg: {
      name: "role",
      description: "One role only (default: all)",
      required: false,
      choices: Object.keys(ROLES),
    },
  },
  plan: {
    description: "Show the plan of this thread (private reply)",
    arg: {
      name: "view",
      description: "history = every version",
      required: false,
      choices: [PLAN_HISTORY_ARG],
    },
  },
  find: {
    description: "Find threads of this space by keywords",
    arg: { name: "keywords", description: "Words to look for", required: true },
  },
  teammate: {
    description: "Manage teammates (ops control channel only)",
    arg: {
      name: "command",
      description:
        "create <space> <name> [model] | list | edit <name> <field> <value> | archive <name>",
      required: true,
    },
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
            // 3 = STRING
            type: 3,
            name: def.arg.name,
            description: def.arg.description,
            required: def.arg.required,
            ...(def.arg.choices && {
              choices: def.arg.choices.map((c) => ({ name: c, value: c })),
            }),
          },
        ]
      : [],
  }));
}

/** What the user typed, as the `/name arg` text that `parseSlash` reads back. */
export function slashText(
  name: string,
  value: (arg: string) => string | number | boolean | null,
): string | null {
  if (!Object.hasOwn(SLASH_DEFINITIONS, name)) return null;
  const def = SLASH_DEFINITIONS[name as SlashName];
  const arg = def.arg;
  const v = arg ? value(arg.name) : null;
  if (!arg || v === null || v === false || v === "") return `/${name}`;
  const s = String(v).trim();
  return `/${name} ${s}`;
}
