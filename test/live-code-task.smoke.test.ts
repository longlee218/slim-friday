import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { ApprovalGateway, ApprovalRequest } from "../src/approvals/approval-types";
import { PLACEHOLDER } from "../src/config/agent-config";
import { createTaskHandler } from "../src/tasks/handle-task";
import { makeEnv } from "./helpers";

// Live test: plan mode -> owner approves plan -> Write inside the scratch dir, through the real SDK.
const key = process.env.OPENROUTER_API_KEY;
const live = !!key && key !== PLACEHOLDER;
if (!live) {
  process.stderr.write("SKIP live code-task smoke: OPENROUTER_API_KEY missing or REPLACE_ME\n");
}

describe.skipIf(!live)("live code task smoke (OpenRouter)", () => {
  test("plan approved by owner, then file written in the task scratch dir", async () => {
    const env = makeEnv({
      OPENROUTER_API_KEY: key!,
      LLM_PROVIDER: "openrouter",
      ...(process.env.LIVE_CODE_MODEL && { MODEL: process.env.LIVE_CODE_MODEL }),
      MAX_TURNS: "10",
      TIMEOUT_MS: "120000",
    });
    const asked: { kind: string; req: ApprovalRequest }[] = [];
    const gw: ApprovalGateway = {
      request: async (req) => (asked.push({ kind: "request", req }), { approved: true }),
      requestPlan: async (req) => (asked.push({ kind: "plan", req }), { approved: true }),
      askChoice: async (a) => a.options[0],
    };
    const handle = createTaskHandler({ db: env.db, config: env.config, approvals: gw });
    const reply = await handle({
      source: "test",
      userId: "u",
      threadId: "live-code1",
      text: "task: Create a file named hello.txt containing exactly the word hi. Plan first, then write it.",
    });

    const tasksDir = join(env.home, "tasks");
    const [taskId] = readdirSync(tasksDir);
    const files = readdirSync(join(tasksDir, taskId!, "scratch"));
    process.stderr.write(
      `live code-task: asked=${JSON.stringify(asked.map((a) => [a.kind, a.req.tool]))} files=${files}\n`,
    );
    const calls = env.db
      .query(
        "SELECT tool, is_error, substr(input_json,1,120) i, substr(output_preview,1,160) o FROM tool_calls",
      )
      .all();
    process.stderr.write(`reply=${reply}\ncalls=${JSON.stringify(calls)}\n`);
    expect(asked.some((a) => a.kind === "plan")).toBe(true);
    expect(files).toContain("hello.txt");
  }, 150_000);
});
