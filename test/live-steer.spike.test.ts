import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type Options, query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

// Spike Q16 (plans/261009-1900-roles-restructure-program/revision-11.md section 7, phase-08 section D).
// What the pinned SDK/CLI does with user messages pushed through STREAMING INPUT while a run is working.
// OPT-IN: SPIKE_Q16=1 (local Claude login, Haiku, tiny per-case budgets, total cap 0.25 USD). Tests only RECORD
// facts (a human writes the verdicts); a surprising answer never fails the suite. Never run in CI.
// Raw evidence: SPIKE_OUT (default <tmp>/friday-spike-q16), sanitized copy in test/fixtures/sdk-steer/q16.json.
const RUN = process.env.SPIKE_Q16 === "1";
const MODEL = "claude-haiku-4-5";
const OUT = process.env.SPIKE_OUT ?? join(tmpdir(), "friday-spike-q16");
const FIXTURE = join(import.meta.dir, "fixtures", "sdk-steer", "q16.json");

/** Only harmless Bash commands: `[sleep N &&] echo TOKEN` or `[sleep N &&] touch name.mark` (in the temp cwd). */
const SAFE_BASH = /^(sleep [0-9]{1,2} && )?(echo [A-Za-z0-9-]{1,20}|touch [a-z0-9]{1,8}\.mark)$/;

/** Push queue exposed as an AsyncIterable<SDKUserMessage>; stays open until close() (like the future run channel). */
function makeChannel() {
  const queue: any[] = [];
  let closed = false;
  let wake: (() => void) | undefined;
  return {
    push(text: string) {
      queue.push({
        type: "user",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
        session_id: "",
      });
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    /** Number of messages the CLI pulled so far is visible to the caller via `pulled`. */
    pulled: [] as { t: number; text: string }[],
    iterable(t0: number): AsyncIterable<any> {
      const self = this;
      return {
        async *[Symbol.asyncIterator]() {
          while (true) {
            if (queue.length) {
              const m = queue.shift();
              self.pulled.push({ t: Date.now() - t0, text: m.message.content });
              yield m;
            } else if (closed) {
              self.pulled.push({ t: Date.now() - t0, text: "<iterable returned>" });
              return;
            } else await new Promise<void>((r) => (wake = r));
          }
        },
      };
    },
  };
}

/** Short, human-readable form of one stream message. */
function brief(m: any): string {
  const c = Array.isArray(m.message?.content) ? m.message.content : [];
  const parts = c.map((b: any) =>
    b.type === "text"
      ? `text:${String(b.text).slice(0, 160)}`
      : b.type === "tool_use"
        ? `tool_use:${b.name}:${JSON.stringify(b.input).slice(0, 80)}`
        : b.type === "tool_result"
          ? `tool_result:${JSON.stringify(b.content).slice(0, 120)}`
          : b.type,
  );
  if (typeof m.message?.content === "string") parts.push(`str:${m.message.content.slice(0, 120)}`);
  if (m.type === "result")
    parts.push(`result:${m.subtype}:${String(m.result ?? "").slice(0, 120)}`);
  return parts.join(" | ");
}

interface Run {
  name: string;
  cwd: string;
  ch: ReturnType<typeof makeChannel>;
  t0: number;
  timeline: { t: number; kind: string; detail: string }[];
  results: any[];
  hookTools: { ev: string; t: number; cmd?: string }[];
  thrown?: string;
  endedAtMs?: number;
  cost?: number;
  q?: ReturnType<typeof query>;
}

const all: Record<string, unknown> = {};

/** One streaming run. `script(run)` is called right after start and drives the pushes/closes with timers. */
async function runCase(
  name: string,
  o: {
    first: string;
    budget: number;
    turns: number;
    hardStopMs: number;
    script: (r: Run, onMsg: (cb: (m: any) => void) => void) => void;
    abort?: AbortController;
  },
): Promise<Run> {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "friday-q16-")));
  mkdirSync(OUT, { recursive: true });
  const t0 = Date.now();
  const ch = makeChannel();
  const run: Run = { name, cwd, ch, t0, timeline: [], results: [], hookTools: [] };
  const ac = o.abort ?? new AbortController();
  const hard = setTimeout(() => ac.abort(), o.hardStopMs);
  const env: Record<string, string | undefined> = {};
  for (const k of ["PATH", "HOME", "USER", "SHELL", "LANG", "TMPDIR"]) env[k] = process.env[k];
  const hook = (ev: string) => ({
    hooks: [
      async (input: any) => {
        run.hookTools.push({ ev, t: Date.now() - t0, cmd: input.tool_input?.command });
        return {};
      },
    ],
  });
  const options: Options = {
    cwd,
    model: MODEL,
    settingSources: [],
    tools: ["Bash"],
    systemPrompt:
      "You are a test driver. Follow instructions exactly. Be terse. Obey the newest user message if it changes the instructions.",
    maxTurns: o.turns,
    maxBudgetUsd: o.budget,
    abortController: ac,
    env,
    // Echo pulled user messages back (isReplay) so the timeline shows WHEN the CLI consumed each one.
    extraArgs: { "replay-user-messages": null },
    canUseTool: async (toolName, input) => {
      const cmd = (input as any).command as string | undefined;
      const ok = toolName === "Bash" && !!cmd && SAFE_BASH.test(cmd.trim());
      run.timeline.push({
        t: Date.now() - t0,
        kind: "canUseTool",
        detail: `${toolName} ${ok ? "ALLOW" : "DENY"} ${cmd ?? ""}`,
      });
      return ok
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: "spike: only SAFE_BASH commands" };
    },
    hooks: {
      PreToolUse: [hook("PreToolUse")],
      PostToolUse: [hook("PostToolUse")],
      PostToolUseFailure: [hook("PostToolUseFailure")],
    } as Options["hooks"],
  };
  ch.push(o.first);
  const listeners: ((m: any) => void)[] = [];
  const q = query({ prompt: ch.iterable(t0) as any, options });
  run.q = q;
  o.script(run, (cb) => listeners.push(cb));
  try {
    for await (const m of q as AsyncIterable<SDKMessage>) {
      const a = m as any;
      const kind = `${a.type}${a.subtype ? `:${a.subtype}` : ""}${a.isReplay ? ":replay" : ""}`;
      // Skip noisy stream housekeeping, keep everything that carries content or lifecycle.
      if (a.type !== "system" || ["init", "compact_boundary", "notification"].includes(a.subtype))
        run.timeline.push({ t: Date.now() - t0, kind, detail: brief(a) });
      if (a.type === "result") {
        run.results.push({
          t: Date.now() - t0,
          subtype: a.subtype,
          turns: a.num_turns,
          cost: a.total_cost_usd,
          text: String(a.result ?? "").slice(0, 200),
        });
        run.cost = a.total_cost_usd;
      }
      for (const cb of listeners) cb(a);
    }
  } catch (e) {
    run.thrown = String(e).slice(0, 300);
  }
  clearTimeout(hard);
  run.endedAtMs = Date.now() - t0;
  const sanitize = (s: string) =>
    s
      .split(cwd)
      .join("<CWD>")
      .split(homedir())
      .join("<HOME>")
      .replace(/\/var\/folders\/[^"\s]+/g, "<TMP>");
  const facts = {
    name,
    endedAtMs: run.endedAtMs,
    thrown: run.thrown,
    cost: run.cost,
    results: run.results,
    pulledByCli: ch.pulled,
    hookTools: run.hookTools,
    markers: ["a", "b", "c"].map((n) => `${n}.mark:${existsSync(join(cwd, `${n}.mark`))}`),
    timeline: run.timeline,
  };
  all[name] = JSON.parse(sanitize(JSON.stringify(facts)));
  writeFileSync(join(OUT, `${name}.json`), sanitize(JSON.stringify(facts, null, 1)));
  process.stderr.write(
    `[q16 ${name}] ended=${run.endedAtMs}ms results=${run.results.length} cost=${run.cost} thrown=${run.thrown ?? "-"}\n`,
  );
  return run;
}

const ago = (r: Run) => Date.now() - r.t0;
const mark = (r: Run, kind: string, detail: string) =>
  r.timeline.push({ t: ago(r), kind: `PUSH:${kind}`, detail });
const isAssistantToolUse = (m: any) =>
  m.type === "assistant" &&
  Array.isArray(m.message?.content) &&
  m.message.content.some((b: any) => b.type === "tool_use");

describe.skipIf(!RUN)("live steer spike Q16 (Haiku, gated by SPIKE_Q16=1)", () => {
  test("Q16", async () => {
    // Case A (a,c): slow tool running, two steers pushed during it. Stream stays open; closed 4 s after result.
    await runCase("A-steer-during-tool", {
      budget: 0.035,
      turns: 6,
      hardStopMs: 90_000,
      first:
        "Run the Bash command `sleep 8 && echo AAA`. Then reply with exactly: DONE-A. Do not run anything else.",
      script: (r, on) => {
        let pushed = false;
        on((m) => {
          if (!pushed && isAssistantToolUse(m)) {
            pushed = true;
            setTimeout(() => {
              mark(r, "steer1", "STEER1");
              r.ch.push("STEER1: when you finish, ALSO append the word ALPHA to your final reply.");
            }, 1500);
            setTimeout(() => {
              mark(r, "steer2", "STEER2");
              r.ch.push("STEER2: and append the word BRAVO after ALPHA.");
            }, 2500);
          }
          if (m.type === "result") setTimeout(() => r.ch.close(), 4000);
        });
      },
    });

    // Case B (b): three Bash calls in ONE turn (each touches a marker after a sleep), steer pushed during the
    // first. Markers + Pre/PostToolUse hooks show which ones ran; tool_results show "skipped"/real outputs.
    await runCase("B-multi-tool-one-turn", {
      budget: 0.04,
      turns: 6,
      hardStopMs: 90_000,
      first:
        "In ONE single response emit exactly three Bash tool calls (parallel, same turn): " +
        "`sleep 3 && touch a.mark`, `sleep 3 && touch b.mark`, `sleep 3 && touch c.mark`. " +
        "Then reply with exactly: DONE-B.",
      script: (r, on) => {
        let pushed = false;
        on((m) => {
          if (!pushed && isAssistantToolUse(m)) {
            pushed = true;
            setTimeout(() => {
              mark(r, "steer", "STOP");
              r.ch.push("STEER: stop, do not run any more commands. Reply with exactly: STEERED.");
            }, 1000);
          }
          if (m.type === "result") setTimeout(() => r.ch.close(), 4000);
        });
      },
    });

    // Case B2 (b, sequential): three Bash calls one per turn; steer pushed during the 1st. Does the model ever
    // reach calls 2 and 3, and what is the order of delivery vs the next tool call.
    await runCase("B2-sequential-tools", {
      budget: 0.04,
      turns: 8,
      hardStopMs: 90_000,
      first:
        "Run these Bash commands strictly one per turn (never parallel): `sleep 4 && touch a.mark`, then `touch b.mark`, then `touch c.mark`. Then reply DONE-B2.",
      script: (r, on) => {
        let pushed = false;
        on((m) => {
          if (!pushed && isAssistantToolUse(m)) {
            pushed = true;
            setTimeout(() => {
              mark(r, "steer", "SKIP-REST");
              r.ch.push("STEER: skip the remaining commands (b and c), just reply STEERED-B2.");
            }, 1000);
          }
          if (m.type === "result") setTimeout(() => r.ch.close(), 4000);
        });
      },
    });

    // Case C (d): no tools. First result, then the iterable stays open: does the CLI wait? Push a 2nd message 5 s
    // AFTER the first result: second result? Then a 3rd message pushed right after the 2nd result.
    await runCase("C-results-per-message", {
      budget: 0.025,
      turns: 4,
      hardStopMs: 60_000,
      first: "Reply with exactly: ONE.",
      script: (r, on) => {
        let n = 0;
        on((m) => {
          if (m.type !== "result") return;
          n++;
          if (n === 1)
            setTimeout(() => {
              mark(r, "after-result-2nd", "TWO");
              r.ch.push("Reply with exactly: TWO.");
            }, 5000);
          if (n === 2) {
            mark(r, "right-after-result-3rd", "THREE");
            r.ch.push("Reply with exactly: THREE.");
          }
          if (n === 3) setTimeout(() => r.ch.close(), 3000);
        });
      },
    });

    // Case E (e): message pushed on the FINAL assistant text (no tool_use) - i.e. after the last turn, before
    // `result` is emitted. Delivered? Second result? Iterable closed 8 s after the first result.
    await runCase("E-push-after-last-turn", {
      budget: 0.025,
      turns: 4,
      hardStopMs: 60_000,
      first: "Run the Bash command `echo EEE`. Then reply with exactly: DONE-E.",
      script: (r, on) => {
        let pushed = false;
        let sawTool = false;
        on((m) => {
          if (isAssistantToolUse(m)) sawTool = true;
          const lastText =
            m.type === "assistant" &&
            sawTool &&
            !isAssistantToolUse(m) &&
            JSON.stringify(m.message?.content).includes("DONE-E");
          if (!pushed && lastText) {
            pushed = true;
            mark(r, "late", "LATE");
            r.ch.push("LATE: reply with exactly: LATE-ACK.");
          }
          if (m.type === "result" && r.results.length === 1) setTimeout(() => r.ch.close(), 8000);
        });
      },
    });

    // Case F1 (f): interrupt() while a tool runs and a steer is pending. Tool killed? result subtype? Is the
    // pending steer (and a message pushed afterwards) delivered, i.e. does the session continue?
    await runCase("F1-interrupt", {
      budget: 0.035,
      turns: 6,
      hardStopMs: 60_000,
      first: "Run the Bash command `sleep 12 && touch a.mark`. Then reply DONE-F1.",
      script: (r, on) => {
        let pushed = false;
        on((m) => {
          if (!pushed && isAssistantToolUse(m)) {
            pushed = true;
            setTimeout(() => {
              mark(r, "steer-pending", "PENDING");
              r.ch.push("STEER: after this, reply with exactly: PENDING-SEEN.");
            }, 1000);
            setTimeout(async () => {
              mark(r, "interrupt()", "");
              try {
                await r.q?.interrupt();
              } catch (e) {
                mark(r, "interrupt-error", String(e).slice(0, 120));
              }
            }, 2000);
            setTimeout(() => {
              mark(r, "after-interrupt", "AFTER");
              r.ch.push("Reply with exactly: AFTER-INTERRUPT.");
            }, 6000);
          }
          if (m.type === "result") setTimeout(() => r.ch.close(), 9000);
        });
      },
    });

    // Case F2 (f): AbortController abort while a tool runs and a steer is pending: stream ends/throws, steer lost.
    const ac = new AbortController();
    await runCase("F2-abort", {
      budget: 0.025,
      turns: 6,
      hardStopMs: 60_000,
      abort: ac,
      first: "Run the Bash command `sleep 12 && touch b.mark`. Then reply DONE-F2.",
      script: (r, on) => {
        let pushed = false;
        on((m) => {
          if (!pushed && isAssistantToolUse(m)) {
            pushed = true;
            setTimeout(() => {
              mark(r, "steer-pending", "PENDING");
              r.ch.push("STEER: reply with exactly: PENDING-SEEN.");
            }, 1000);
            setTimeout(() => {
              mark(r, "abort()", "");
              ac.abort();
            }, 2000);
          }
        });
      },
    });

    const total = Object.values(all).reduce<number>((s, f: any) => s + (f.cost ?? 0), 0);
    all.totalCostUsd = total;
    mkdirSync(join(import.meta.dir, "fixtures", "sdk-steer"), { recursive: true });
    writeFileSync(FIXTURE, `${JSON.stringify(all, null, 1)}\n`);
    process.stderr.write(`[q16] TOTAL cost=${total} USD\n`);
    expect(total).toBeLessThan(0.3);
  }, 600_000);
});
