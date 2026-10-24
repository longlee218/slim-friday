/* Owner-run live smoke of packages/runtime-claude (about $0.05, NOT part of `bun test`):
   bun run scripts/smoke-runtime-claude.ts
   It opens one bot with a background subagent, asks it to start the helper, and prints every runtime event and
   permission call. Compare the `taskId` of the helper's tool calls with the `task_started` taskId: they should match
   (assumption: SDK `agentID` == `task_id`). Also check that `session.id` is the id the SDK reports in `init`. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bot, BotRuntimeSpec } from "@friday/core";
import { ClaudeRuntime } from "@friday/runtime-claude";
import { HAIKU_MODEL } from "../apps/friday/src/config/model-ids";

const token = Bun.env.CLAUDE_CODE_OAUTH_TOKEN;
if (!token) throw new Error("CLAUDE_CODE_OAUTH_TOKEN missing (put it in .env)");

const home = mkdtempSync(join(tmpdir(), "friday-smoke-"));
const bot: Bot = {
  id: "smoke",
  name: "Smoke",
  title: "test bot",
  instructions: "Reply in one short sentence.",
  model: HAIKU_MODEL,
  tools: ["Read", "Agent"],
  skills: [],
  subagents: [
    {
      name: "helper",
      description: "Reads one file and reports its first line.",
      prompt: "Read the file you are told to and report its first line.",
      tools: ["Read"],
      model: HAIKU_MODEL,
    },
  ],
  workspaces: [process.cwd()],
};
const spec: BotRuntimeSpec = {
  bot,
  async decide(call) {
    console.log("decide", call.tool, "taskId=", call.taskId);
    return { behavior: "allow" };
  },
};

const runtime = new ClaudeRuntime({
  oauthToken: token,
  agentHome: join(home, "agent-home"),
  scratchRoot: join(home, "runs"),
  env: { ...process.env },
});
const session = await runtime.open(spec);
console.log("session", session.id);
session.send({
  conversationId: "smoke",
  from: { kind: "user" },
  text: "Start the helper in the background to read README.md, then answer 'started' right away.",
  hop: 0,
  context: [],
});
const timer = setTimeout(() => void session.stop(), 90_000);
for await (const e of session.events) {
  console.log(e);
  if (e.type === "task_done") break;
}
clearTimeout(timer);
await session.stop();
