/**
 * Owner-run live check (spends real model calls; never part of `bun test`):
 *   bun run eval:memory --live [--cap-usd 0.5]
 * Case `memory-after-resume`: a session opened with memory "codeword AMBER" is resumed with memory "codeword COBALT"
 * through `openRunSession`; the bot must answer COBALT (the fresh memory), not AMBER (the old state).
 * Case `prompt-vs-transcript` (information only, never fails the run): the first turn never names the codeword, the
 * resume drops the `<state_changed>` block; COBALT means the system prompt is rebuilt at resume (so transcript
 * anchoring was the pre-fix cause), AMBER confirms the SDK keeps the first prompt (a snapshot).
 * Both cases share the cost cap. Writes `<AGENT_HOME>/logs/eval-memory-<stamp>.json` and prints one line per case.
 * Without `--live` it only prints usage.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime } from "@friday/core";
import { ClaudeRuntime } from "@friday/runtime-claude";
import { ask, type CaseResult, fakeStore, openWith, QUESTION } from "./eval-memory-live-harness";

const USAGE = "Usage: bun run eval:memory --live [--cap-usd 0.5]  (spends real model calls)";
const out = (s: string) => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);

const args = process.argv.slice(2);
if (!args.includes("--live")) {
  out(USAGE);
  process.exit(0);
}
const capIdx = args.indexOf("--cap-usd");
const capUsd = capIdx >= 0 ? Number(args[capIdx + 1]) : 0.5;
if (!(capUsd > 0)) {
  err(`--cap-usd must be a positive number. ${USAGE}`);
  process.exit(1);
}
const logHome = process.env.AGENT_HOME;
if (!logHome) {
  err("AGENT_HOME is not set: the result file goes to <AGENT_HOME>/logs.");
  process.exit(1);
}

/** Which codeword a reply names (only one of them, else "neither"). */
const saidOf = (reply: string) => {
  const cobalt = reply.includes("COBALT");
  const amber = reply.includes("AMBER");
  return cobalt && !amber ? "COBALT" : amber && !cobalt ? "AMBER" : "neither";
};

/**
 * Open with AMBER, send `firstText`, then resume with COBALT and ask for the codeword (with the state block only
 * when `sendBlock`). Returns both replies, or why the resume could not be tested.
 */
async function resumeAndAsk(
  runtime: AgentRuntime,
  spent: { usd: number },
  firstText: string,
  sendBlock: boolean,
): Promise<{ first: string; second: string } | { failed: string }> {
  const store = fakeStore();
  const firstOpen = await openWith(runtime, store, "AMBER");
  const first = await ask(firstOpen.session, spent, firstText);
  // As a run's pump does at its first model event (the turn has ended here).
  await firstOpen.commitState();
  if (spent.usd > capUsd) return { failed: `cap ${capUsd} USD passed` };
  const resumed = await openWith(runtime, store, "COBALT");
  // openRunSession falls back to a fresh session when resume throws; that would pass without testing resume.
  if (resumed.session.id !== firstOpen.session.id) {
    await resumed.session.stop();
    return { failed: "resume did not happen" };
  }
  const block = sendBlock ? resumed.stateChanged : undefined;
  const second = await ask(resumed.session, spent, QUESTION, block);
  return { first: first.trim(), second: second.trim() };
}

/** Pass/fail: the resumed session, sent the state block, answers with the fresh memory. */
async function memoryAfterResume(runtime: AgentRuntime): Promise<CaseResult> {
  const name = "memory-after-resume";
  const r = await resumeAndAsk(runtime, spent, QUESTION, true);
  if ("failed" in r) return { case: name, passed: false, costUsd: spent.usd, detail: r.failed };
  const detail = `first reply: ${r.first} | resumed reply: ${r.second}`;
  if (spent.usd > capUsd)
    return { case: name, passed: false, costUsd: spent.usd, detail: `cap passed | ${detail}` };
  return { case: name, passed: saidOf(r.second) === "COBALT", costUsd: spent.usd, detail };
}

/** Information only: which cause the pre-fix AMBER/AMBER had. It never fails the run. */
async function promptVsTranscript(runtime: AgentRuntime): Promise<CaseResult> {
  const info = { case: "prompt-vs-transcript", passed: true, informational: true };
  const r = await resumeAndAsk(runtime, spent, "Reply with OK", false);
  if ("failed" in r) return { ...info, costUsd: spent.usd, detail: `not measured: ${r.failed}` };
  if (spent.usd > capUsd)
    return { ...info, costUsd: spent.usd, detail: `cap ${capUsd} USD passed` };
  const said = saidOf(r.second);
  const meaning = {
    COBALT: "the prompt is rebuilt at resume: transcript anchoring was the cause",
    AMBER: "the prompt snapshot is confirmed",
    neither: "unclear",
  }[said];
  const detail = `first reply: ${r.first} | resumed reply (no block): ${r.second} | said ${said}: ${meaning}`;
  return { ...info, costUsd: spent.usd, detail, said };
}

/** Run one case; a throw becomes its result (an informational case still never fails the run). */
async function runCase(name: string, informational: boolean, run: () => Promise<CaseResult>) {
  try {
    return await run();
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return { case: name, passed: informational, informational, costUsd: spent.usd, detail };
  }
}

const tmp = mkdtempSync(join(tmpdir(), "friday-eval-memory-"));
const runtime = new ClaudeRuntime({
  oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  agentHome: join(tmp, "home"),
  scratchRoot: join(tmp, "scratch"),
  env: process.env,
});
const spent = { usd: 0 };
const results: CaseResult[] = [];
try {
  results.push(await runCase("memory-after-resume", false, () => memoryAfterResume(runtime)));
  // The information case runs only while the shared cap has room.
  if (spent.usd <= capUsd)
    results.push(await runCase("prompt-vs-transcript", true, () => promptVsTranscript(runtime)));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
const logs = join(logHome, "logs");
mkdirSync(logs, { recursive: true });
const file = join(logs, `eval-memory-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
for (const r of results) {
  const tag = r.informational ? "INFO" : r.passed ? "PASS" : "FAIL";
  out(`${tag} ${r.case} ($${r.costUsd.toFixed(4)}) ${r.detail}`);
}
out(`Result: ${file}`);
process.exit(results.every((r) => r.informational || r.passed) ? 0 : 1);
