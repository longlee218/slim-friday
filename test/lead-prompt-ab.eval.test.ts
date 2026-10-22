import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { PLACEHOLDER } from "../src/config/agent-config";
import { workspacePaths } from "../src/config/workspace-paths";
import { channelMemoryFile } from "../src/memory/channel-memory";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { addLocation, initMsg, makeEnv, resultMsg, TEST_CHANNEL } from "./helpers";
import { decisionOf } from "./lead-golden-support";
import { sleep, until } from "./lead-harness";
import { isLeadRun } from "./mcp-run-probe";

/*
 * Opt-in PAID A/B of the lead prompt (AB_EVAL=1 and a real token): each case of `<AB_OUT>/cases.json` runs the REAL lead
 * once per arm (AB_ARMS): `real` (or `old`) = the built prompt as is; `v21` / `v22` = a draft from plans/reports swapped
 * in by the query wrapper. Workers are stubbed. Results go to `<AB_OUT>/results.json`. AB_CAPTURE=1 runs free: stub
 * lead, writes the system prompt per arm. Knobs: AB_ONLY (case ids), AB_REPEAT, AB_BUDGET (USD stop), AB_OWNER_WS (owner
 * persona files to copy; omitted = the test defaults), AB_RULE + AB_RULE_IN=agents|memory (one owner rule placed in the
 * workspace AGENTS.md or the channel MEMORY.md).
 */
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const capture = process.env.AB_CAPTURE === "1";
const live = process.env.AB_EVAL === "1" && !!token && token !== PLACEHOLDER;
const OUT = process.env.AB_OUT ?? "/tmp/lead-ab";
const BUDGET = Number(process.env.AB_BUDGET ?? 4);
const DRAFTS: Record<string, string> = {
  v21: join(import.meta.dir, "..", "plans/reports/draft-261022-0852-lead-prompt-v2.md"),
  v22: join(import.meta.dir, "..", "plans/reports/draft-261022-1019-lead-prompt-v22.md"),
};
const OWNER_WS = process.env.AB_OWNER_WS ?? "";
const OWNER_FILES = ["AGENTS.md", "IDENTITY.md", "SOUL.md", "USER.md"];
/** Optional owner rule (AB_RULE) placed in the workspace AGENTS.md or the channel MEMORY.md (AB_RULE_IN=agents|memory). */
const RULE = process.env.AB_RULE ?? "";
const RULE_IN = process.env.AB_RULE_IN ?? "";

interface AbCase {
  id: string;
  text: string;
  /** Accepted decisions, e.g. "DIRECT:researcher", "ANSWER", "PLAN". */
  accept: string[];
}

/** The fenced block of the draft that follows `marker` (```markdown or ```xml). */
function draftBlock(draft: string, after: string, fence: string): string {
  const d = readFileSync(draft, "utf8");
  const from = d.indexOf(fence, d.indexOf(after)) + fence.length;
  return d.slice(from, d.indexOf("\n```", from)).trim();
}

/** Today's prompt -> v2.1: core replaces contract + skill; owner files and team wrapped in XML; tail (memory, title) kept last. */
function toV21(sp: string, locations: string[], draft: string): string {
  const core = draftBlock(draft, "## LỚP 1", "```markdown\n");
  const team = draftBlock(draft, "## LỚP 3", "```xml\n").replace(
    /Locations \(the only names a brief may use\):\n(?:- .*\n?)+/,
    `Locations (the only names a brief may use):\n${locations.map((l) => `- ${l} [git]`).join("\n")}\n`,
  );
  const files: string[] = [];
  const tailAt = sp.search(/\n(Memory from earlier tasks|This thread has no title yet)/);
  const tail = tailAt >= 0 ? sp.slice(tailAt).trim() : "";
  const body = tailAt >= 0 ? sp.slice(0, tailAt) : sp;
  for (const m of body.matchAll(/\n## ([A-Z]+\.md)\n([\s\S]*?)(?=\n## [A-Z]+\.md\n|$)/g))
    if (m[1] !== "TEAM.md") files.push(`<file name="${m[1]}">\n${m[2]?.trim()}\n</file>`);
  return [core, `<owner_files>\n${files.join("\n")}\n</owner_files>`, team, tail]
    .filter(Boolean)
    .join("\n\n");
}

const cases = (): AbCase[] => JSON.parse(readFileSync(join(OUT, "cases.json"), "utf8")) as AbCase[];

describe.skipIf(!live && !capture)("lead prompt A/B (arms per AB_ARMS)", () => {
  test("decisions per case and arm", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    mkdirSync(OUT, { recursive: true });
    const rows: Record<string, unknown>[] = [];
    let spent = 0;
    const only = (process.env.AB_ONLY ?? "").split(",").filter(Boolean);
    const repeat = Math.max(1, Number(process.env.AB_REPEAT ?? 1));
    const picked = cases().filter((c) => !only.length || only.includes(c.id));
    const list = capture
      ? picked.slice(0, 1)
      : picked.flatMap((c) => Array(repeat).fill(c) as AbCase[]);
    for (const c of list)
      for (const arm of (process.env.AB_ARMS ?? "real").split(",")) {
        if (spent > BUDGET) break;
        const env = makeEnv({ CLAUDE_CODE_OAUTH_TOKEN: token ?? "x", TIMEOUT_MS: "120000" });
        const locs = ["location", "friday-slim-agent", "friday-webui"];
        for (const l of locs.slice(1)) addLocation(env.home, l);
        const ws = workspacePaths(env.home).workspace("main");
        for (const f of OWNER_FILES)
          if (OWNER_WS && existsSync(join(OWNER_WS, f)))
            copyFileSync(join(OWNER_WS, f), join(ws.root, f));
        if (RULE && RULE_IN === "agents")
          appendFileSync(join(ws.root, "AGENTS.md"), `\n- ${RULE}\n`);
        if (RULE && RULE_IN === "memory") {
          const mem = channelMemoryFile(env.home, "main", "main-agent");
          mkdirSync(dirname(mem), { recursive: true });
          writeFileSync(mem, `# main-agent\n\n## Owner preferences\n- ${RULE}\n`);
        }
        let reply = "";
        let cost = 0;
        let turns = 0;
        const tools: string[] = [];
        const queryFn = (a: { prompt: unknown; options?: Record<string, unknown> }) => {
          if (!isLeadRun(a.options))
            return (async function* () {
              yield initMsg;
              yield resultMsg({ result: "stub", total_cost_usd: 0 });
            })();
          const sp = a.options?.systemPrompt;
          if (typeof sp !== "string") throw new Error("lead systemPrompt is not a string");
          const next = arm === "old" || arm === "real" ? sp : toV21(sp, locs, DRAFTS[arm] ?? "");
          if (capture) {
            writeFileSync(join(OUT, `system-${arm}.md`), next);
            return (async function* () {
              yield initMsg;
              yield resultMsg({ result: "", total_cost_usd: 0 });
            })();
          }
          const it = query({ ...a, options: { ...a.options, systemPrompt: next } } as never);
          return (async function* () {
            for await (const m of it as AsyncIterable<Record<string, unknown>>) {
              if (m.type === "assistant")
                for (const b of ((m.message as { content?: unknown[] })?.content ?? []) as Record<
                  string,
                  unknown
                >[])
                  if (b.type === "tool_use")
                    tools.push(`${b.name} ${JSON.stringify(b.input).slice(0, 80)}`);
              if (m.type === "result") {
                cost = Number(m.total_cost_usd ?? 0);
                turns = Number(m.num_turns ?? 0);
                reply = String(m.result ?? "");
              }
              yield m;
            }
          })();
        };
        const handle = createTurnHandler({
          db: env.db,
          config: env.config,
          queryFn: queryFn as never,
          leadTiming: { announceWindowMs: 3_600_000 },
          post: async () => {},
        });
        await handle({
          source: "test",
          channelId: TEST_CHANNEL,
          userId: "owner",
          threadId: `ab-${c.id}-${arm}`,
          text: c.text,
        });
        await until(() => !!env.db.query("SELECT 1 FROM turns WHERE role = 'lead'").get(), 30_000);
        await until(
          () =>
            !env.db.query("SELECT 1 FROM turns WHERE role = 'lead' AND status = 'running'").get(),
          180_000,
        );
        await sleep(500);
        const d = decisionOf(env.db);
        const calls = env.db
          .query<{ c: string }, []>(
            "SELECT tool || ' ' || substr(coalesce(result, ''), 1, 80) c FROM effect_log WHERE scope = 'lead tool call' ORDER BY rowid",
          )
          .all()
          .map((r) => r.c);
        const got = d.roles.length ? `${d.strategy}:${d.roles.join(",")}` : d.strategy;
        spent += cost;
        rows.push({
          id: c.id,
          arm,
          got,
          ok: c.accept.includes(got),
          cost,
          turns,
          calls,
          tools,
          reply,
        });
        env.db.close();
        writeFileSync(join(OUT, "results.json"), JSON.stringify(rows, null, 2));
      }
    process.stderr.write(`A/B done: ${rows.length} runs, $${spent.toFixed(2)}\n`);
    expect(rows.length).toBeGreaterThan(0);
  }, 3_600_000);
});
