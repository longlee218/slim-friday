import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkToolCall, guardFor } from "../src/guardrails/check-tool-call";
import { AGENT_TOOL_NAME, SEND_MESSAGE_TOOL_NAME } from "../src/tools/sdk-tool-names";

// Shared setup of the spawn/resume guard tests: the REAL recorded hook shapes (spike Q19 fixtures).

export const SIG = { signal: new AbortController().signal };
export const WT = "/ws/repo";
const FIX = join(import.meta.dir, "fixtures", "sdk-hooks");
const q19: any[] = JSON.parse(readFileSync(join(FIX, "q19-hook-inputs.json"), "utf8"));
const recorded = (event: string, tool: string) =>
  q19.find((h) => h.hook_event_name === event && h.tool_name === tool);
/** Recorded main-agent Agent / SendMessage inputs (`name: worker`, `model: haiku`, `run_in_background: false`). */
export const SPAWN_IN = recorded("PreToolUse", AGENT_TOOL_NAME).tool_input;
export const POST_AGENT = recorded("PostToolUse", AGENT_TOOL_NAME);
export const SEND_IN = recorded("PreToolUse", SEND_MESSAGE_TOOL_NAME).tool_input;

export const exec = (cls?: "mechanical" | "standard" | "design") =>
  guardFor("exec", { cwd: WT, writePaths: [WT], readPaths: [WT], gitWriteRepo: WT }, cls);
export const spawn = (over: Record<string, unknown>, ctx = exec()) =>
  checkToolCall(AGENT_TOOL_NAME, { ...SPAWN_IN, subagent_type: "implementer", ...over }, ctx);
