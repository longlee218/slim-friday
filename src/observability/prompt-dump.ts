import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { AgentConfig } from "../config/agent-config";
import { PROMPT_DUMP_KEEP } from "../config/prompt-dump-config";
import { logEvent, logger } from "./logger";
import { redactText } from "./redact";

/** Logger of this module. */
const log = logger.child({ module: "prompt-dump" });

/** Folder of the dumps, inside AGENT_HOME (denied to every agent process). */
export const promptDumpDir = (agentHome: string): string => join(agentHome, "logs", "prompts");

/** What one dump is made of: the SDK options of the run plus the turn's user prompt. */
export interface PromptDumpInput {
  config: AgentConfig;
  role: string;
  /** Thread id (or the task id when the run has no thread): its first 8 chars name the file. */
  threadId: string;
  turnId: string;
  /** Exactly the options passed to the SDK `query()`. */
  options: Options;
  /** The user prompt of the turn. */
  prompt: string;
  /** Clock seam (tests). */
  now?: Date;
}

/** Names of the tools of each in-process MCP server (an external server has none to list). */
function mcpToolLines(options: Options): string[] {
  return Object.entries(options.mcpServers ?? {}).map(([name, s]) => {
    const registered = (s as { instance?: { _registeredTools?: object } }).instance
      ?._registeredTools;
    return `- ${name} (${s.type ?? "sdk"}): ${registered ? Object.keys(registered).join(", ") : "external, tools not listed"}`;
  });
}

/** The list lines of an option that may be unset. */
const list = (items: readonly string[] | undefined): string =>
  items?.length ? items.map((t) => `- ${t}`).join("\n") : "- none";

/** The system prompt as the SDK receives it, with its base (custom string or preset + appended text). */
function systemPromptSection(sp: Options["systemPrompt"]): string {
  if (typeof sp === "string") return `base: custom (our text alone)\n\n${sp}`;
  if (Array.isArray(sp)) return `base: custom (our text alone)\n\n${sp.join("\n")}`;
  if (sp?.type === "preset")
    return `base: preset ${sp.preset}, our text appended\n\n${sp.append ?? ""}`;
  if (sp?.type === "custom")
    return `base: custom (our text alone)\n\n${[sp.prompt].flat().join("\n")}`;
  return "base: SDK default";
}

/** The markdown of one dump. Never includes `options.env` or any credential option. */
export function renderPromptDump(i: PromptDumpInput): string {
  const o = i.options;
  const plugins = (o.plugins ?? []).map((p) => `${p.type}: ${p.path}`);
  return [
    `# Prompt dump: ${i.role}`,
    `- time: ${(i.now ?? new Date()).toISOString()}`,
    `- thread: ${i.threadId}`,
    `- turn: ${i.turnId}`,
    "",
    "## Run settings",
    `- model: ${o.model}`,
    `- permissionMode: ${o.permissionMode ?? "default"}`,
    `- maxTurns: ${o.maxTurns}`,
    `- maxBudgetUsd: ${o.maxBudgetUsd ?? "none"}`,
    `- thinking: ${JSON.stringify(o.thinking ?? "sdk default")}`,
    `- cwd: ${o.cwd}`,
    `- resume: ${o.resume ?? "none"}`,
    `- sandbox: ${o.sandbox ? "on" : "off"}`,
    "",
    "## Built-in tools",
    Array.isArray(o.tools) ? list(o.tools) : `- ${JSON.stringify(o.tools ?? "sdk default")}`,
    "",
    "## allowedTools",
    list(o.allowedTools),
    "",
    "## disallowedTools",
    list(o.disallowedTools),
    "",
    "## MCP servers",
    mcpToolLines(o).join("\n") || "- none",
    "",
    "## Skills",
    list(o.skills as string[] | undefined),
    "",
    "## Plugins",
    list(plugins),
    "",
    "## System prompt",
    systemPromptSection(o.systemPrompt),
    "",
    "## User prompt",
    i.prompt,
    "",
  ].join("\n");
}

/** Delete the oldest dumps beyond `keep` (names start with the ISO time, so name order is time order). */
function prune(dir: string, keep: number): void {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) rmSync(join(dir, f));
}

/** Log the one start event when the dump is on. */
export function logPromptDumpEnabled(config: AgentConfig): void {
  if (config.dumpPrompts)
    logEvent(log, "prompt_dump.enabled", {
      dir: promptDumpDir(config.agentHome),
      keep: PROMPT_DUMP_KEEP,
    });
}

/**
 * Debug dump (`FRIDAY_DUMP_PROMPTS=1`): write what one model run sends to the SDK to
 * `<AGENT_HOME>/logs/prompts/<ISO time>-<role>-<thread8>.md` (mode 0600, secrets masked), then keep the newest
 * `PROMPT_DUMP_KEEP` files. No-op when off. Never throws: a failure is one warning and the run goes on.
 */
export function dumpPrompt(i: PromptDumpInput): void {
  if (!i.config.dumpPrompts) return;
  try {
    const dir = promptDumpDir(i.config.agentHome);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = (i.now ?? new Date()).toISOString().replaceAll(":", "-");
    const file = join(dir, `${stamp}-${i.role}-${i.threadId.slice(0, 8)}.md`);
    writeFileSync(file, redactText(renderPromptDump(i)), { mode: 0o600 });
    chmodSync(file, 0o600);
    prune(dir, PROMPT_DUMP_KEEP);
  } catch (err) {
    logEvent(log, "prompt_dump.failed", { error: String(err).slice(0, 200) }, "warn");
  }
}
