import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decide } from "@friday/core";
import { DEFAULTS_DIR } from "../src/load-config";
import { parseToolsFile } from "../src/schemas/tools-file";

/** The shipped tool annotations. */
const specs = parseToolsFile(readFileSync(join(DEFAULTS_DIR, "tools.yaml"), "utf8"));

/** The decision for one call of `tool` at autonomy `careful` in a clean run, with no rule or override. */
const atCareful = (tool: string) =>
  decide({
    call: { botId: "b", conversationId: "c", tool, input: {} },
    spec: specs.find((s) => s.name === tool),
    grants: [],
    settings: { level: "careful" },
    now: 0,
  }).outcome;

test("UpdateProfile, the scratchpad writes and the schedule tools need no card even at careful (spec §6.9: intro runs ask none)", () => {
  for (const tool of [
    "mcp__chat__UpdateProfile",
    "mcp__scratchpad__ScratchpadAdd",
    "mcp__scratchpad__ScratchpadUpdate",
    "mcp__scratchpad__ScratchpadComplete",
    "mcp__scratchpad__ScratchpadRemove",
    "mcp__schedules__ScheduleList",
    "mcp__schedules__ScheduleCreate",
    "mcp__schedules__ScheduleUpdate",
    "mcp__schedules__ScheduleDelete",
  ])
    expect({ tool, outcome: atCareful(tool) }).toEqual({ tool, outcome: "allow" });
});
