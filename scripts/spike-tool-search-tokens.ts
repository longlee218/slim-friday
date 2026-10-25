/* Owner-run live spike (costs a few cents, NOT part of `bun test`): bun scripts/spike-tool-search-tokens.ts
   Measures the input tokens of turn 1 for an in-process MCP server with N dummy tools under
   ENABLE_TOOL_SEARCH on / off / auto:10, and with alwaysLoad on the server. Prints one line per case. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

if (!Bun.env.CLAUDE_CODE_OAUTH_TOKEN) {
  console.error("CLAUDE_CODE_OAUTH_TOKEN missing (put it in .env)");
  process.exit(1);
}
const cwd = mkdtempSync(join(tmpdir(), "spike-ts-"));
const COUNT = 60;

/** COUNT dummy tools with a realistic description and a 4-field schema. */
const dummyTools = () =>
  Array.from({ length: COUNT }, (_, i) =>
    tool(
      `Dummy${i}`,
      `Dummy tool number ${i}. Looks up a record in the ${i}th external system by id and returns its fields, filters and status.`,
      {
        id: z.string().describe("Record id"),
        filter: z.string().optional().describe("Optional filter expression"),
        limit: z.number().optional().describe("Max rows"),
        cursor: z.string().optional().describe("Page cursor"),
      },
      async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
    ),
  );

/** One one-turn query; returns the usage of the first assistant message (turn 1 input). */
async function measure(label: string, search: string | undefined, alwaysLoad: boolean) {
  const server = createSdkMcpServer({ name: "dummy", tools: dummyTools(), alwaysLoad });
  const env: Record<string, string | undefined> = { ...process.env };
  env.ENABLE_TOOL_SEARCH = search;
  let usage: Record<string, number> | undefined;
  for await (const m of query({
    prompt: "Reply with the single word: ok. Do not call any tool.",
    options: {
      model: "claude-sonnet-4-5",
      tools: search === "false" ? ["Read"] : ["Read", "ToolSearch"],
      mcpServers: { dummy: server },
      settingSources: [],
      permissionMode: "default",
      maxTurns: 1,
      cwd,
      env,
    },
  })) {
    if (m.type === "assistant" && !usage) usage = m.message.usage as unknown as Record<string, number>;
  }
  const u = usage ?? {};
  const total = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  console.log(`${label.padEnd(28)} total_input=${total} (fresh=${u.input_tokens} cache_write=${u.cache_creation_input_tokens} cache_read=${u.cache_read_input_tokens})`);
}

await measure("on (default)", undefined, false);
await measure("off", "false", false);
await measure("auto:10", "auto:10", false);
await measure("on + server alwaysLoad", undefined, true);
