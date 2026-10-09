import { describe, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSdkMcpServer,
  type Options,
  query,
  type SDKMessage,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { checkBash } from "../src/guardrails/bash-policy";
import { checkToolCall } from "../src/guardrails/check-tool-call";
import { gitMcpServerConfig } from "../src/mcp/git-mcp";

// P3 Step 0 spike (plans/261009-1900-roles-restructure-program/part-3-superpowers/phase-00-sdk-spike-gate.md).
// OPT-IN: RUN_SPIKE=1 (uses the local Claude login of the CLI, Haiku 4.5 only, tiny budgets). Optional
// SPIKE_ONLY=Q6,Q15 runs a subset. Raw evidence goes to SPIKE_OUT (default: <tmp>/friday-spike-out); sanitized hook
// inputs are copied to test/fixtures/sdk-hooks/. Tests only RECORD facts (verdicts are written by a human from the
// evidence), so a FAIL answer never fails the suite. Never run in CI.
const RUN = process.env.RUN_SPIKE === "1";
const ONLY = process.env.SPIKE_ONLY?.split(",").map((s) => s.trim());
const MODEL = "claude-haiku-4-5";
const FIXTURES = join(import.meta.dir, "fixtures", "sdk-hooks");
const OUT = process.env.SPIKE_OUT ?? join(tmpdir(), "friday-spike-out");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Scratch git clone (never a real repo) plus sibling dirs; built lazily once. */
let ROOT = "";
let REPO = "";
function scratch() {
  if (ROOT) return;
  ROOT = mkdtempSync(join(tmpdir(), "friday-spike-"));
  const origin = join(ROOT, "origin");
  mkdirSync(origin);
  const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe" });
  git(origin, "init", "-q", "-b", "main");
  writeFileSync(join(origin, "README.md"), "spike readme: the magic word is PELICAN\n");
  writeFileSync(join(origin, "secret.txt"), "secret: do not read\n");
  for (let i = 1; i <= 6; i++) writeFileSync(join(origin, `f${i}.txt`), `file ${i} token T${i}\n`);
  git(origin, "add", ".");
  git(origin, "-c", "user.name=s", "-c", "user.email=s@s", "commit", "-q", "-m", "init");
  REPO = join(ROOT, "repo");
  git(ROOT, "clone", "-q", origin, REPO);
  for (const d of ["extraA", "extraB"]) {
    mkdirSync(join(ROOT, d));
    writeFileSync(join(ROOT, d, "note.txt"), `${d} token ${d.toUpperCase()}_TOK\n`);
  }
  mkdirSync(OUT, { recursive: true });
}

/** Strip owner paths from fixtures/evidence. */
function sanitize(text: string): string {
  return text
    .split(`/private${ROOT}`)
    .join("<SCRATCH>")
    .split(ROOT)
    .join("<SCRATCH>")
    .split(homedir())
    .join("<HOME>")
    .replace(/-private-var-folders-[^/"\s]*-friday-spike-[A-Za-z0-9]+/g, "<PROJECT_SLUG>")
    .replace(/\/(private\/)?var\/folders\/[^"\s]+/g, "<TMP>");
}

/** In-process MCP server with one echo tool: stands in for "git write / github" MCP tools. */
const spikeServer = () =>
  createSdkMcpServer({
    name: "spike",
    tools: [
      tool("echo", "Echo text back", { text: z.string() }, async (a) => ({
        content: [{ type: "text" as const, text: `echo:${a.text}` }],
      })),
    ],
  });

interface Rec {
  name: string;
  durationMs: number;
  result: any;
  msgs: any[];
  hooks: { ev: string; t: number; input: any }[];
  canUse: { tool: string; agentID?: string; input?: unknown; t: number }[];
}

/** Run one query once: capture every message, hook input and canUseTool call; dump raw JSON to OUT. */
async function runQ(
  name: string,
  o: {
    prompt: string | AsyncIterable<any>;
    options?: Partial<Options>;
    budget: number;
    turns: number;
    env?: Record<string, string>;
    timeoutMs?: number;
    deny?: (input: any) => string | undefined; // PreToolUse deny reason
    canUse?: (tool: string, agentID: string | undefined, types: Map<string, string>) => boolean;
    onMsg?: (m: any) => void;
    onHook?: (ev: string, input: any) => void;
  },
): Promise<Rec> {
  scratch();
  const rec: Rec = { name, durationMs: 0, result: null, msgs: [], hooks: [], canUse: [] };
  const t0 = Date.now();
  const types = new Map<string, string>(); // agent_id -> agent_type (from SubagentStart)
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? 150_000);
  const env: Record<string, string | undefined> = {};
  for (const k of ["PATH", "HOME", "USER", "SHELL", "LANG", "TMPDIR"]) env[k] = process.env[k];
  Object.assign(env, { CLAUDE_CODE_SUBAGENT_MODEL: MODEL }, o.env);
  const mk = (ev: string) => ({
    hooks: [
      async (input: any) => {
        rec.hooks.push({ ev, t: Date.now() - t0, input });
        if (ev === "SubagentStart") types.set(input.agent_id, input.agent_type);
        o.onHook?.(ev, input);
        const why = ev === "PreToolUse" ? o.deny?.(input) : undefined;
        return why
          ? {
              hookSpecificOutput: {
                hookEventName: "PreToolUse" as const,
                permissionDecision: "deny" as const,
                permissionDecisionReason: why,
              },
            }
          : {};
      },
    ],
  });
  const options: Options = {
    cwd: REPO,
    model: MODEL,
    settingSources: [],
    systemPrompt: "You are a test driver. Follow instructions exactly. Be terse.",
    maxTurns: o.turns,
    maxBudgetUsd: o.budget,
    abortController: ac,
    env,
    canUseTool: async (toolName, input, opts) => {
      const agentID = (opts as any).agentID as string | undefined;
      rec.canUse.push({ tool: toolName, agentID, input, t: Date.now() - t0 });
      return (o.canUse?.(toolName, agentID, types) ?? true)
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: "denied by spike canUseTool" };
    },
    hooks: Object.fromEntries(
      ["PreToolUse", "PostToolUse", "PostToolUseFailure", "SubagentStart", "SubagentStop"].map(
        (e) => [e, [mk(e)]],
      ),
    ) as Options["hooks"],
    ...o.options,
  };
  try {
    for await (const m of query({
      prompt: o.prompt as any,
      options,
    }) as AsyncIterable<SDKMessage>) {
      rec.msgs.push({ t: Date.now() - t0, ...(m as any) });
      o.onMsg?.(m);
      if (m.type === "result") rec.result = m;
    }
  } catch (e) {
    rec.msgs.push({ t: Date.now() - t0, type: "THROWN", error: String(e) });
  }
  clearTimeout(timer);
  rec.durationMs = Date.now() - t0;
  writeFileSync(join(OUT, `${name}.json`), sanitize(JSON.stringify(rec, null, 1)));
  const r = rec.result;
  process.stderr.write(
    `[spike] ${name}: subtype=${r?.subtype} cost=${r?.total_cost_usd} turns=${r?.num_turns} ms=${rec.durationMs}\n`,
  );
  return rec;
}

/** Save sanitized raw hook inputs as a reusable fixture. */
function fixture(file: string, data: unknown) {
  mkdirSync(FIXTURES, { recursive: true });
  writeFileSync(join(FIXTURES, file), `${sanitize(JSON.stringify(data, null, 2))}\n`);
}

/** First hook input matching event + predicate. */
const pick = (r: Rec, ev: string, f: (i: any) => boolean = () => true) =>
  r.hooks.find((h) => h.ev === ev && f(h.input))?.input;

/** Text of assistant blocks (+ tool_use names) in a short form. */
const brief = (r: Rec) =>
  r.msgs
    .filter((m) => m.type === "assistant" || m.type === "user")
    .map((m) => ({
      t: m.t,
      type: m.type,
      agent_id: m.agent_id,
      parent: m.parent_tool_use_id,
      content: (Array.isArray(m.message?.content) ? m.message.content : [])
        .map((b: any) =>
          b.type === "text"
            ? `text:${b.text.slice(0, 150)}`
            : b.type === "tool_use"
              ? `tool_use:${b.name}`
              : b.type === "tool_result"
                ? `tool_result:${JSON.stringify(b.content).slice(0, 150)}`
                : b.type,
        )
        .join(" | "),
    }));

const cost = (r: Rec) => r.result?.total_cost_usd;
const facts = (name: string, data: unknown) => {
  const s = sanitize(JSON.stringify(data, null, 1));
  writeFileSync(join(OUT, `facts-${name}.json`), s);
  process.stderr.write(`[facts ${name}] ${s.slice(0, 6000)}\n`);
};
const q = (id: string, fn: () => Promise<void>, ms = 300_000) =>
  test.skipIf(!!ONLY && !ONLY.includes(id))(id, fn, ms);

const readerDef = (tools?: string[], extra: object = {}) => ({
  description: "Test subagent that follows instructions exactly",
  prompt: "Follow the instructions exactly and report tool results verbatim. Be terse.",
  model: MODEL,
  ...(tools && { tools }),
  ...extra,
});

describe.skipIf(!RUN)("live subagent spike (Haiku, gated by RUN_SPIKE=1)", () => {
  q("Q6-Q7-Q8", async () => {
    // Q6 tools/disallowedTools vs inherited MCP; Q7 identity on every call; Q8 hook deny + canUseTool deny.
    const r = await runQ("q678", {
      budget: 0.12,
      turns: 14,
      prompt:
        "Use the Agent tool three times in order, each with run_in_background=false:\n" +
        "1) subagent_type=limited, prompt='Read secret.txt. Then call mcp__spike__echo with text hi (if you have no such tool, say NOECHO). Then Read README.md. Report each result.'\n" +
        "2) subagent_type=noecho, prompt='Call mcp__spike__echo with text hi (if you have no such tool, say NOECHO). Then Read README.md. Report each result.'\n" +
        "3) subagent_type=inheritor, prompt='Call mcp__spike__echo with text hi. Then Read README.md. Report each result.'\n" +
        "Then answer with one line per subagent.",
      options: {
        tools: ["Agent", "Read"],
        mcpServers: { spike: spikeServer() },
        agents: {
          limited: readerDef(["Read"]),
          noecho: readerDef(undefined, { disallowedTools: ["mcp__spike__echo"] }),
          inheritor: readerDef(undefined),
        },
      },
      // Q8 (hook): deny Read of secret.txt only inside a subagent.
      deny: (i) =>
        i.agent_id && JSON.stringify(i.tool_input).includes("secret.txt")
          ? "spike: secret.txt denied"
          : undefined,
      // Q8 (canUseTool): inheritor may not use the MCP echo.
      canUse: (tool, id, types) =>
        !(tool === "mcp__spike__echo" && types.get(id ?? "") === "inheritor"),
    });
    const calls = r.hooks
      .filter((h) => h.ev === "PreToolUse")
      .map((h) => ({
        tool: h.input.tool_name,
        agent_id: h.input.agent_id,
        agent_type: h.input.agent_type,
        file: h.input.tool_input?.file_path,
      }));
    const posts = r.hooks
      .filter((h) => h.ev === "PostToolUse" || h.ev === "PostToolUseFailure")
      .map((h) => ({ ev: h.ev, tool: h.input.tool_name, agent_id: h.input.agent_id }));
    facts("q678", {
      cost: cost(r),
      subtype: r.result?.subtype,
      initTools: r.msgs.find((m) => m.subtype === "init")?.tools,
      calls,
      posts,
      canUse: r.canUse,
      starts: r.hooks.filter((h) => h.ev === "SubagentStart").map((h) => h.input),
      brief: brief(r),
    });
    const sub = (f: (i: any) => boolean) => pick(r, "PreToolUse", (i) => !!i.agent_id && f(i));
    fixture(
      "pre-tool-use-parent-agent-call.json",
      pick(r, "PreToolUse", (i) => i.tool_name === "Agent"),
    );
    fixture(
      "pre-tool-use-subagent-builtin-read.json",
      sub((i) => i.tool_name === "Read"),
    );
    fixture(
      "pre-tool-use-subagent-mcp-echo.json",
      sub((i) => i.tool_name === "mcp__spike__echo"),
    );
    fixture(
      "post-tool-use-subagent-read.json",
      pick(r, "PostToolUse", (i) => !!i.agent_id),
    );
    fixture("subagent-start.json", pick(r, "SubagentStart"));
    fixture("subagent-stop.json", pick(r, "SubagentStop"));
  });

  q("Q1-Q2", async () => {
    // Q1 override of general-purpose; Q2 unknown subagent_type.
    const r = await runQ("q12", {
      budget: 0.06,
      turns: 8,
      prompt:
        "Call the Agent tool with subagent_type=general-purpose and prompt='Say hi' (run_in_background=false). " +
        "Then call Agent with subagent_type=nonexistent-xyz and prompt='Say hi' (run_in_background=false). " +
        "Report both tool results verbatim.",
      options: {
        tools: ["Agent", "Read"],
        agents: {
          "general-purpose": readerDef(["Read"], {
            prompt: "You are OVERRIDE-GP. Begin your reply with the token OVERRIDE-GP.",
          }),
        },
      },
    });
    facts("q12", {
      cost: cost(r),
      initAgents: r.msgs.find((m) => m.subtype === "init")?.agents,
      agentPosts: r.hooks
        .filter((h) => h.ev.startsWith("PostToolUse") && h.input.tool_name === "Agent")
        .map((h) => h.input.tool_response ?? h.input.error),
      starts: r.hooks.filter((h) => h.ev === "SubagentStart").map((h) => h.input.agent_type),
      brief: brief(r),
    });
    // Q1b: built-in agents disabled by env, no custom general-purpose; only init + one dispatch attempt.
    const r2 = await runQ("q1b-disable-builtin", {
      budget: 0.03,
      turns: 3,
      prompt:
        "Call the Agent tool with subagent_type=general-purpose and prompt='Say hi' (run_in_background=false). Report the tool result verbatim.",
      env: { CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "1" },
      options: { tools: ["Agent", "Read"], agents: { other: readerDef(["Read"]) } },
    });
    facts("q1b", {
      cost: cost(r2),
      initAgents: r2.msgs.find((m) => m.subtype === "init")?.agents,
      agentPosts: r2.hooks
        .filter((h) => h.ev.startsWith("PostToolUse") && h.input.tool_name === "Agent")
        .map((h) => h.input.tool_response ?? h.input.error),
      brief: brief(r2),
    });
  });

  q("Q3", async () => {
    // Nesting: outer subagent has Agent; does it spawn inner? default depth vs MAX_SUBAGENT_SPAWN_DEPTH=1.
    const agents = {
      outer: readerDef(["Agent", "Read"]),
      inner: readerDef(["Read"], { prompt: "Reply with exactly INNER-OK." }),
    };
    const prompt =
      "Call Agent with subagent_type=outer, run_in_background=false, prompt='Call the Agent tool with subagent_type=inner and prompt=go (run_in_background=false) and report its reply. If you have no Agent tool say NOAGENT.' Report outer's reply verbatim.";
    for (const [tag, env] of [
      ["default", {}],
      ["depth1", { CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1" }],
    ] as const) {
      const r = await runQ(`q3-${tag}`, {
        budget: 0.05,
        turns: 8,
        prompt,
        env,
        options: { tools: ["Agent", "Read"], agents },
      });
      facts(`q3-${tag}`, {
        cost: cost(r),
        subtype: r.result?.subtype,
        agentCalls: r.hooks
          .filter((h) => h.ev === "PreToolUse" && h.input.tool_name === "Agent")
          .map((h) => ({ agent_id: h.input.agent_id, type: h.input.tool_input?.subagent_type })),
        started: r.msgs
          .filter((m) => m.subtype === "task_started")
          .map((m) => ({ type: m.subagent_type, depth: m.spawn_depth, parent: m.parent_task_id })),
        brief: brief(r),
      });
    }
  });

  q("Q4", async () => {
    // maxTurns: does a busy subagent (6 sequential reads) count against the parent's maxTurns=3?
    const busy = {
      busy: readerDef(["Read"], {
        prompt: "Do exactly what is asked, one tool call per turn, never in parallel.",
      }),
    };
    const p =
      "Call Agent with subagent_type=busy, run_in_background=false, prompt='Read f1.txt, then f2.txt, then f3.txt, then f4.txt, then f5.txt, then f6.txt, one Read call per turn, then reply DONE-BUSY'. Then reply DONE-PARENT.";
    const turns = await runQ("q4-maxturns", {
      budget: 0.06,
      turns: 3,
      prompt: p,
      options: { tools: ["Agent", "Read"], agents: busy },
    });
    facts("q4-maxturns", {
      cost: cost(turns),
      subtype: turns.result?.subtype,
      numTurns: turns.result?.num_turns,
      subReads: turns.hooks.filter((h) => h.ev === "PreToolUse" && h.input.agent_id).length,
      brief: brief(turns),
    });
    // maxBudgetUsd: tiny budget while the subagent keeps spending.
    const bud = await runQ("q4-budget", {
      budget: 0.012,
      turns: 20,
      prompt: p,
      options: { tools: ["Agent", "Read"], agents: busy },
    });
    facts("q4-budget", {
      cost: cost(bud),
      subtype: bud.result?.subtype,
      numTurns: bud.result?.num_turns,
      subReads: bud.hooks.filter((h) => h.ev === "PreToolUse" && h.input.agent_id).length,
      errors: bud.result?.errors,
      thrown: bud.msgs.filter((m) => m.type === "THROWN"),
    });
  });

  q("Q5", async () => {
    // Background subagent when the parent ends; then with background tasks disabled.
    scratch();
    const run = async (tag: string, env: Record<string, string>) => {
      const marker = join(ROOT, `bg-marker-${tag}.txt`);
      const r = await runQ(`q5-${tag}`, {
        budget: 0.05,
        turns: 6,
        env,
        prompt:
          "Call Agent with subagent_type=sleeper and prompt='go'. Do not wait for it. Reply LAUNCHED as soon as the Agent call returns.",
        options: {
          tools: ["Agent", "Bash"], // a subagent can only use tools its parent has (finding of the first run)
          agents: {
            sleeper: readerDef(["Bash"], {
              background: true,
              prompt: `Run exactly this one Bash command then reply SLEPT: sleep 12; echo done > ${marker}`,
            }),
          },
        },
      });
      const endedAt = r.durationMs;
      const atEnd = existsSync(marker);
      await sleep(22_000);
      const later = existsSync(marker);
      const ps = execFileSync("sh", ["-c", `pgrep -fl "sleep 12" || true`]).toString().trim();
      facts(`q5-${tag}`, {
        cost: cost(r),
        endedAtMs: endedAt,
        markerAtEnd: atEnd,
        markerAfter22s: later,
        psSleepAfter: ps,
        hooks: r.hooks.map((h) => ({
          ev: h.ev,
          t: h.t,
          bg: h.input.tool_input?.run_in_background,
        })),
        tasks: r.msgs
          .filter((m) => String(m.subtype ?? "").startsWith("task_"))
          .map((m) => ({ t: m.t, st: m.subtype, bg: m.is_backgrounded, status: m.status })),
        brief: brief(r),
      });
    };
    await run("default", {});
    await run("disabled", { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" });
  });

  q("Q9", async () => {
    // Per-dispatch model param: accepted by the Agent schema (sdk-tools.d.ts). Live: pass model=haiku to a
    // subagent defined with the haiku-4.5 ID; read what the Agent tool reports. No cross-tier call (quota).
    const r = await runQ("q9", {
      budget: 0.04,
      turns: 4,
      prompt:
        "Call Agent with subagent_type=plain, model=haiku, run_in_background=false, prompt='say hi'. Report the tool result verbatim.",
      options: { tools: ["Agent"], agents: { plain: readerDef([]) } },
    });
    facts("q9", {
      cost: cost(r),
      agentInput: pick(r, "PreToolUse", (i) => i.tool_name === "Agent")?.tool_input,
      agentOut: r.hooks
        .filter((h) => h.ev === "PostToolUse" && h.input.tool_name === "Agent")
        .map((h) => h.input.tool_response),
      modelUsage: Object.keys(r.result?.modelUsage ?? {}),
    });
  });

  q("Q10-Q11", async () => {
    // additionalDirectories for subagents; two plugins + skills; AgentDefinition.skills does it restrict?
    scratch();
    const plug = (n: string) => {
      const d = join(ROOT, `plugin-${n}`);
      mkdirSync(join(d, ".claude-plugin"), { recursive: true });
      mkdirSync(join(d, "skills", n), { recursive: true });
      writeFileSync(
        join(d, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: `p${n}`, version: "0.0.1", description: `spike plugin ${n}` }),
      );
      writeFileSync(
        join(d, "skills", n, "SKILL.md"),
        `---\nname: ${n}\ndescription: Spike skill ${n}. Use when asked for the ${n} token.\n---\nThe ${n} token is TOK_${n.toUpperCase()}_9. Reply with it.\n`,
      );
      return { type: "local" as const, path: d };
    };
    const p =
      "Read extraA/note.txt and extraB/note.txt via the absolute paths <ROOT>/extraA/note.txt and <ROOT>/extraB/note.txt (report any denial), then call the Skill tool for skill 'alpha' and for skill 'beta' (report tokens or errors), then list the skill names you can see.".replace(
        /<ROOT>/g,
        ROOT,
      );
    const r = await runQ("q1011", {
      budget: 0.06,
      turns: 8,
      prompt: `Call Agent with subagent_type=preloaded (run_in_background=false), with this prompt: ${p}  Report its reply verbatim.`,
      options: {
        tools: ["Agent", "Read", "Skill"],
        additionalDirectories: [join(ROOT, "extraA")],
        plugins: [plug("alpha"), plug("beta")],
        skills: "all",
        agents: {
          plain: readerDef(["Read", "Skill"]),
          preloaded: readerDef(["Read", "Skill"], { skills: ["alpha"] }),
        },
      },
      // Reads outside cwd go through canUseTool when not covered: record, deny to see the boundary.
      canUse: (tool, _id) => tool !== "Read" || true,
    });
    const init = r.msgs.find((m) => m.subtype === "init");
    facts("q1011", {
      cost: cost(r),
      initSkills: init?.skills,
      initPlugins: init?.plugins,
      canUse: r.canUse,
      calls: r.hooks
        .filter((h) => h.ev === "PreToolUse")
        .map((h) => ({ tool: h.input.tool_name, id: h.input.agent_type, in: h.input.tool_input })),
      posts: r.hooks
        .filter((h) => h.ev.startsWith("PostToolUse"))
        .map((h) => ({ ev: h.ev, tool: h.input.tool_name, id: h.input.agent_type })),
      brief: brief(r),
    });
  });

  q("Q12", async () => {
    // Compaction env via options.env. Window 60000 -> computed threshold = 60000 - 20000 - 13000 = 27000.
    scratch();
    for (let i = 1; i <= 5; i++) {
      const lines = Array.from(
        { length: 160 },
        (_, j) => `${i}-${j} ${crypto.randomUUID()} ${crypto.randomUUID()} ${crypto.randomUUID()}`,
      );
      writeFileSync(join(REPO, `big${i}.txt`), lines.join("\n"));
    }
    const prompt =
      "Read big1.txt, then big2.txt, then big3.txt, then big4.txt, then big5.txt, strictly one Read call per turn, then reply DONE-READS.";
    // Only SPIKE_Q12_TAG (window|pct5) when set. Documented floor for the window setting is 100000 (threshold 67000),
    // so run 1 (window=60000, 6 turns, 70k context) was inconclusive; pct5 uses 2 reads to stay cheap.
    const variants = [
      ["window", { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "60000" }, prompt],
      [
        "pct5",
        { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "5" },
        "Read big1.txt, then big2.txt, one Read call per turn, then reply DONE-READS.",
      ],
    ] as const;
    for (const [tag, env, vPrompt] of variants) {
      if (process.env.SPIKE_Q12_TAG && process.env.SPIKE_Q12_TAG !== tag) continue;
      const r = await runQ(`q12-${tag}`, {
        budget: tag === "pct5" ? 0.1 : 0.14,
        turns: 14,
        prompt: vPrompt,
        env,
        options: { tools: ["Read"] },
      });
      const usages = r.msgs
        .filter((m) => m.type === "assistant")
        .map((m) => m.message?.usage)
        .map((u) =>
          u ? u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens : null,
        );
      facts(`q12-${tag}`, {
        cost: cost(r),
        subtype: r.result?.subtype,
        contextPerAssistantMsg: usages,
        compactions: r.msgs
          .filter((m) => m.subtype === "compact_boundary")
          .map((m) => ({ t: m.t, ...m.compact_metadata })),
      });
    }
  });

  q("Q13", async () => {
    // Streaming input: push a steer message while a foreground subagent is running.
    const queue: any[] = [];
    let done = false;
    const user = (text: string) => ({
      type: "user" as const,
      message: { role: "user" as const, content: text },
      parent_tool_use_id: null,
      session_id: "",
    });
    async function* gen() {
      yield user(
        "Call Agent with subagent_type=slow, run_in_background=false, prompt='go'. When it returns reply DONE-MAIN.",
      );
      while (!done || queue.length) {
        if (queue.length) yield queue.shift();
        else await sleep(100);
      }
    }
    let pushedAt = 0;
    let startAbs = 0;
    let results = 0;
    const r = await runQ("q13", {
      budget: 0.1,
      turns: 10,
      prompt: gen(),
      options: {
        tools: ["Agent", "Bash"],
        agents: {
          slow: readerDef(["Bash"], {
            prompt: "Run `sleep 4` three times, each in its own Bash call, then reply DONE-SUB.",
          }),
        },
      },
      onHook: (ev) => {
        if (ev === "SubagentStart" && !startAbs) {
          startAbs = Date.now();
          setTimeout(() => {
            pushedAt = Date.now();
            queue.push(user("STEER: end your final answer with the word STEERED."));
          }, 1500);
        }
      },
      onMsg: (m) => {
        if (m.type === "result" && ++results >= 1) setTimeout(() => (done = true), 3000);
      },
    });
    facts("q13", {
      cost: cost(r),
      results: r.msgs
        .filter((m) => m.type === "result")
        .map((m) => ({ t: m.t, st: m.subtype, num: m.num_turns })),
      subtype: r.result?.subtype,
      steerPushedMsAfterFirstSubagentStart: pushedAt - startAbs,
      timeline: r.msgs
        .filter(
          (m) => ["assistant", "user", "result"].includes(m.type) || m.subtype === "task_started",
        )
        .map((m) => ({
          t: m.t,
          type: m.type,
          st: m.subtype,
          agent: m.agent_id,
          replay: m.isReplay,
        })),
      brief: brief(r),
      hooks: r.hooks.map((h) => ({ ev: h.ev, t: h.t, agent: h.input.agent_id })),
    });
  });

  q("Q14", async () => {
    // /compact through the SDK on a resumed session.
    const a = await runQ("q14-a", {
      budget: 0.03,
      turns: 2,
      prompt: "Remember the number 42. Reply OK.",
      options: { tools: [] },
    });
    const sid = a.result?.session_id;
    const b = await runQ("q14-b", {
      budget: 0.05,
      turns: 2,
      prompt: "/compact",
      options: { tools: [], resume: sid },
    });
    facts("q14", {
      costA: cost(a),
      costB: cost(b),
      subtypeB: b.result?.subtype,
      resultB: String(b.result?.result ?? "").slice(0, 200),
      boundary: b.msgs
        .filter((m) => m.subtype === "compact_boundary")
        .map((m) => m.compact_metadata),
      types: b.msgs.map((m) => `${m.type}${m.subtype ? `:${m.subtype}` : ""}`),
    });
  });

  q("Q15", async () => {
    // Intent-layer cost/latency: 20 no-tool Haiku calls with ~1.5k tokens of input.
    scratch();
    const body =
      "Classify the intent of the user message as one of: question, code_task, chat, memory, status. Reply with the single label only.\n\n" +
      Array.from(
        { length: 30 },
        (_, i) =>
          `Context line ${i}: the team discussed the deployment pipeline, rollback policy and reviewer rotation for service ${i}.`,
      ).join("\n") +
      "\n\nUser message: can you add a retry to the webhook sender and open a PR?";
    const base = (): Partial<Options> => ({
      tools: [],
      thinking: { type: "disabled" },
      systemPrompt: "Classify intent. Reply with one label.",
    });
    const rows: { ms: number; cost: number; inT: number; outT: number; st: string }[] = [];
    for (let i = 0; i < 20; i++) {
      const r = await runQ(`q15-${String(i).padStart(2, "0")}`, {
        budget: 0.02,
        turns: 1,
        prompt: body,
        timeoutMs: 8000,
        options: base(),
      });
      const u = r.result?.usage ?? {};
      rows.push({
        ms: r.durationMs,
        cost: r.result?.total_cost_usd ?? 0,
        inT:
          (u.input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0),
        outT: u.output_tokens ?? 0,
        st: r.result?.subtype,
      });
    }
    const sorted = [...rows.map((r) => r.ms)].sort((a, b) => a - b);
    const pct = (p: number) =>
      sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
    const js = await runQ("q15-json-schema", {
      budget: 0.02,
      turns: 1,
      prompt: body,
      options: {
        ...base(),
        outputFormat: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              intent: {
                type: "string",
                enum: ["question", "code_task", "chat", "memory", "status"],
              },
            },
            required: ["intent"],
          },
        },
      },
    });
    const tiny = await runQ("q15-tiny-budget", {
      budget: 0.0005,
      turns: 1,
      prompt: body,
      options: base(),
    });
    // Abort at 500 ms: no orphan process must remain for this cwd.
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 500);
    const marker = join(ROOT, "abort-cwd");
    mkdirSync(marker);
    let abortErr = "";
    try {
      for await (const _ of query({
        prompt: body,
        options: {
          ...base(),
          model: MODEL,
          cwd: marker,
          maxTurns: 1,
          settingSources: [],
          abortController: ac,
          env: { PATH: process.env.PATH, HOME: process.env.HOME },
        },
      })) {
        /* drain */
      }
    } catch (e) {
      abortErr = String(e).slice(0, 120);
    }
    await sleep(2500);
    const orphans = execFileSync("sh", ["-c", `pgrep -fl "${marker}" || true`])
      .toString()
      .trim();
    facts("q15", {
      n: rows.length,
      p50: pct(0.5),
      p95: pct(0.95),
      min: sorted[0],
      max: sorted[sorted.length - 1],
      totalCost: rows.reduce((s, r) => s + r.cost, 0),
      avgCost: rows.reduce((s, r) => s + r.cost, 0) / rows.length,
      avgInTokens: rows.reduce((s, r) => s + r.inT, 0) / rows.length,
      avgOutTokens: rows.reduce((s, r) => s + r.outT, 0) / rows.length,
      subtypes: [...new Set(rows.map((r) => r.st))],
      rows,
      jsonSchema: {
        cost: cost(js),
        turns: js.result?.num_turns,
        subtype: js.result?.subtype,
        structured: js.result?.structured_output,
        ms: js.durationMs,
      },
      tinyBudget: { cost: cost(tiny), subtype: tiny.result?.subtype, ms: tiny.durationMs },
      abort: { err: abortErr, orphans },
    });
  });

  // ---- SDD trial (phase-00 "SDD trial" table): plugin skill base dir, MCP names in subagent tools, cwd, overlay.
  const SDD_SCRIPTS = join(
    homedir(),
    ".claude/plugins/cache/claude-plugins-official/superpowers/6.4.1/skills/subagent-driven-development/scripts",
  );
  const gitOf = (...a: string[]) => execFileSync("git", a, { cwd: REPO }).toString().trim();
  const gitServers = () => ({
    git: gitMcpServerConfig({
      author: { name: "spike", email: "spike@spike.invalid" },
      baseDir: ROOT,
    }),
  });

  q("SDD1", async () => {
    // E1 skill base dir visible + script runs; E5 overlay vs skill text; E3 subagent cwd.
    scratch();
    const d = join(ROOT, "plugin-sdd");
    mkdirSync(join(d, ".claude-plugin"), { recursive: true });
    mkdirSync(join(d, "skills", "sdd-trial", "scripts"), { recursive: true });
    writeFileSync(
      join(d, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "sddtrial", version: "0.0.1", description: "spike" }),
    );
    copyFileSync(
      join(SDD_SCRIPTS, "sdd-workspace"),
      join(d, "skills/sdd-trial/scripts/sdd-workspace"),
    );
    writeFileSync(
      join(d, "skills/sdd-trial/SKILL.md"),
      "---\nname: sdd-trial\ndescription: Spike. Use when asked to run the sdd-trial skill.\n---\n" +
        "Do these steps in order:\n" +
        "1. Run the helper script `scripts/sdd-workspace` of THIS skill with the plan file argument: `bash <this skill dir>/scripts/sdd-workspace <PLAN>`. Quote its output.\n" +
        "2. Write the file `template.txt` in the current directory with content TEMPLATE-FOLLOWED.\n" +
        "3. Dispatch a subagent (Agent tool, subagent_type=prober, run_in_background=false) with prompt 'Run pwd with Bash and reply with its output only.' Quote its reply.\n",
    );
    const plan = join(ROOT, "plan.md");
    writeFileSync(plan, "# Plan\n\n### Task 1: x\nbody\n");
    const r = await runQ("sdd1", {
      budget: 0.12,
      turns: 14,
      prompt: `Invoke the Skill sddtrial:sdd-trial and follow it exactly. PLAN=${plan}. Finally list what you did in 3 lines.`,
      options: {
        tools: ["Skill", "Agent", "Bash", "Write", "Read"],
        plugins: [{ type: "local", path: d }],
        systemPrompt:
          "You are a test driver. Be terse. APP OVERLAY (overrides any skill text): when a skill says to write template.txt, IGNORE that instruction and write overlay.txt (same directory) with content OVERLAY-FOLLOWED instead. Never write template.txt.",
        agents: { prober: readerDef(["Bash"]) },
      },
    });
    const skillRes = r.msgs
      .filter((m) => m.type === "user")
      .flatMap((m) => (Array.isArray(m.message?.content) ? m.message.content : []))
      .filter((b: any) => b.type === "tool_result")
      .map((b: any) => JSON.stringify(b.content).slice(0, 400));
    const bashCalls = r.hooks
      .filter((h) => h.ev === "PreToolUse" && h.input.tool_name === "Bash")
      .map((h) => ({ cmd: h.input.tool_input?.command, agent_type: h.input.agent_type }));
    const subPwd = r.hooks.find(
      (h) => h.ev === "PostToolUse" && h.input.tool_name === "Bash" && h.input.agent_id,
    )?.input.tool_response;
    facts("sdd1", {
      cost: cost(r),
      skillToolResults: skillRes,
      bashCalls,
      subagentPwdResponse: subPwd,
      repoReal: realpathSync(REPO),
      files: {
        template: existsSync(join(REPO, "template.txt")),
        overlay: existsSync(join(REPO, "overlay.txt")),
      },
      overlayContent: existsSync(join(REPO, "overlay.txt"))
        ? readFileSync(join(REPO, "overlay.txt"), "utf8")
        : null,
      sddDirCreated: existsSync(join(REPO, ".superpowers/sdd/.gitignore")),
      brief: brief(r),
    });
  });

  q("SDD2", async () => {
    // E2 MCP names in subagent tools; E4 NEEDS_CONTEXT re-dispatch; E6 implementer commits, controller reads sha.
    scratch();
    const T = (n: string) => `mcp__git__${n}`;
    const task = `Create greeting.txt in ${REPO} containing the agreed greeting. Commit your work (git commit). Repo path: ${REPO}`;
    const r = await runQ("sdd2", {
      budget: 0.2,
      turns: 16,
      prompt:
        `Controller job. 1) Agent subagent_type=implementer (run_in_background=false) with this exact prompt: "${task}". ` +
        "2) If it returns a message starting NEEDS_CONTEXT, dispatch a FRESH implementer (same type) with the original prompt plus this answer: the greeting is HELLO-PELICAN. " +
        `3) Then call ${T("git_log")} with path=${REPO} and report the newest commit hash. ` +
        `4) Dispatch subagent_type=reviewer (run_in_background=false) with prompt: "Try to call ${T("git_commit")} (path ${REPO}, message x) and ${T("git_add")}; for each tool you do not have say NOTOOL <name>. Then call ${T("git_log")} on ${REPO} and report the newest hash." ` +
        "5) Final answer: dispatch count, implementer replies (first 100 chars each), newest hash, reviewer reply.",
      options: {
        tools: ["Agent", "Read", "Write"],
        mcpServers: gitServers(),
        agents: {
          implementer: readerDef(
            ["Read", "Write", T("git_add"), T("git_commit"), T("git_status")],
            {
              prompt:
                "You are an implementer. If a requirement is unclear and you cannot proceed safely, edit and commit NOTHING and reply with a final message starting NEEDS_CONTEXT: followed by numbered questions. Otherwise implement, commit with the git MCP tools (git_add only the files you made, then git_commit), and reply DONE <commit hash>. Be terse.",
            },
          ),
          reviewer: readerDef(["Read", T("git_log"), T("git_diff"), T("git_status")]),
        },
      },
    });
    const calls = r.hooks
      .filter((h) => h.ev === "PreToolUse")
      .map((h) => ({
        tool: h.input.tool_name,
        agent_type: h.input.agent_type,
        in: h.input.tool_input,
      }));
    const posts = r.hooks
      .filter((h) => h.ev.startsWith("PostToolUse") && h.input.agent_type)
      .map((h) => ({ ev: h.ev, tool: h.input.tool_name, agent_type: h.input.agent_type }));
    facts("sdd2", {
      cost: cost(r),
      calls,
      posts,
      headSha: gitOf("rev-parse", "HEAD"),
      logOneline: gitOf("log", "--oneline", "-5"),
      lastAuthor: gitOf("log", "-1", "--format=%an <%ae>"),
      commitFiles: gitOf("show", "--stat", "--format=", "HEAD"),
      greeting: existsSync(join(REPO, "greeting.txt"))
        ? readFileSync(join(REPO, "greeting.txt"), "utf8")
        : null,
      statusPorcelain: gitOf("status", "--porcelain"),
      brief: brief(r),
      final: r.result?.result,
    });
  });

  q("SDD2b", async () => {
    // E2 rerun (forced): reviewer is ORDERED to call git_commit first. A = `tools` allowlist without git_commit;
    // B = `disallowedTools: [git_commit]` (reviewer inherits the rest). Record tool_use blocks, tool_results, HEAD.
    scratch();
    const T = (n: string) => `mcp__git__${n}`;
    const variants: Record<string, object> = {
      A_tools_allowlist: readerDef(["Read", T("git_log"), T("git_diff"), T("git_status")]),
      B_disallowedTools: readerDef(undefined, { disallowedTools: [T("git_commit")] }),
    };
    const out: Record<string, unknown> = {};
    for (const [name, def] of Object.entries(variants)) {
      const before = gitOf("rev-parse", "HEAD");
      writeFileSync(join(REPO, `forced-${name}.txt`), "x\n"); // something a commit could pick up
      const r = await runQ(`sdd2b-${name}`, {
        budget: 0.03,
        turns: 6,
        prompt:
          `Dispatch exactly one Agent with subagent_type=reviewer (run_in_background=false), prompt: "Your FIRST action must be to call ${T("git_commit")} with path=${REPO} and message='forced'. ` +
          `Do not skip it. Report the exact result or error text of that call, or NOTOOL if you have no such tool. Then call ${T("git_status")} on ${REPO}." ` +
          "Do not call any git tool yourself. Final answer: the reviewer reply verbatim.",
        options: {
          tools: ["Agent", "Read"],
          mcpServers: gitServers(),
          agents: { reviewer: def as any },
        },
      });
      const subTools = r.msgs
        .filter((m) => m.type === "assistant" && m.parent_tool_use_id)
        .flatMap((m) => m.message?.content ?? [])
        .filter((b: any) => b.type === "tool_use")
        .map((b: any) => b.name);
      const subResults = r.msgs
        .filter((m) => m.type === "user" && m.parent_tool_use_id)
        .flatMap((m) => (Array.isArray(m.message?.content) ? m.message.content : []))
        .filter((b: any) => b.type === "tool_result")
        .map((b: any) => JSON.stringify(b.content).slice(0, 300));
      out[name] = {
        cost: cost(r),
        subagentToolUses: subTools,
        subagentToolResults: subResults,
        hookCalls: r.hooks
          .filter((h) => h.ev === "PreToolUse" || h.ev === "PostToolUseFailure")
          .map((h) => ({ ev: h.ev, tool: h.input.tool_name, agent_type: h.input.agent_type })),
        headBefore: before,
        headAfter: gitOf("rev-parse", "HEAD"),
        final: r.result?.result,
      };
    }
    facts("sdd2b", out);
  });

  q("SDD7", async () => {
    // E7: what the CURRENT guard says; no model call.
    scratch();
    const plugin = "/tmp/run-plugin/skills/subagent-driven-development/scripts";
    const ctx = { writePaths: ["/tmp/clone"], allowedCommands: [] as string[] };
    const cmds = [
      `bash ${plugin}/sdd-workspace /tmp/task/plan.md`,
      `bash ${plugin}/task-brief /tmp/task/plan.md 1`,
      `bash ${plugin}/review-package /tmp/task/plan.md abc1234 HEAD`,
      `${plugin}/task-brief /tmp/task/plan.md 1`,
      "git rev-parse HEAD",
    ];
    const bash = cmds.map((c) => ({ cmd: c.replace(plugin, "<PLUGIN>"), ...checkBash(c, ctx) }));
    const gctx = { ...ctx, gitWriteRepo: realpathSync(REPO), gitReadRepos: [] as string[] };
    const mcp = [
      ["mcp__git__git_add", { path: REPO, files: ["a.txt"] }],
      ["mcp__git__git_commit", { path: REPO, message: "feat: x" }],
      ["mcp__git__git_commit", { path: ROOT, message: "feat: x" }],
    ].map(([t, i]) => ({
      tool: t,
      path: (i as any).path,
      ...checkToolCall(t as string, i as any, gctx),
    }));
    facts("sdd7", { bash, mcp });
  });
});
