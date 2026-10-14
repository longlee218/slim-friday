import { expect, test } from "bun:test";
import { readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { loadConfig } from "../src/config/agent-config";
import { locationMemoryFile } from "../src/memory/location-memory";
import { createMemoryRunner } from "../src/memory/memory-command-handler";
import { compactExitCode, parseCompactArgs } from "../src/memory/memory-compact-args";
import { type CompactLlm, compactTargets, sdkCompactLlm } from "../src/memory/memory-compaction";
import { buildCompacted } from "../src/memory/memory-compaction-prompt";
import { formatCompactResult } from "../src/memory/memory-compaction-report";
import { locationTarget } from "../src/memory/memory-targets";
import { captureLogs } from "../src/observability/logger";
import { emptyUsage } from "../src/observability/record-run";
import { makeEnv, resultMsg, TEST_CHANNEL } from "./helpers";

const stub =
  (text: string): CompactLlm =>
  async () => ({ text, usage: emptyUsage() });

/** Big location memory (over 80% of 8000) with bullets `- the deploy pipeline step number N ...`. */
function big(env: ReturnType<typeof makeEnv>, extra = "") {
  const t = locationTarget(env.home, "main", "location");
  const b = Array.from(
    { length: 140 },
    (_, i) => `- the deploy pipeline step number ${i} uses cache folder alpha${i}`,
  );
  writeFileSync(
    t.file,
    `# location memory\n\nIntro.\n\n## 2026-01-01 a\n${b.slice(0, 70).join("\n")}\n${extra}\n## 2026-03-05 b\n${b.slice(70).join("\n")}\n`,
  );
  return { t, b };
}

test("CLI args: strict flags, typo is an error, exit code reflects failures", () => {
  expect(parseCompactArgs([])).toEqual({ dryRun: false, global: false });
  expect(parseCompactArgs(["--dry-run", "--workspace", "w", "--global"])).toEqual({
    dryRun: true,
    global: true,
    workspace: "w",
  });
  expect(parseCompactArgs(["--dryrun"])).toEqual({ error: "unknown argument: --dryrun" });
  expect(parseCompactArgs(["--workspace"])).toHaveProperty("error");
  expect(parseCompactArgs(["--workspace", "--global"])).toHaveProperty("error");
  const ok = { status: "skipped", label: "x", chars: 1, cap: 2 } as const;
  expect(compactExitCode([ok])).toBe(0);
  expect(compactExitCode([ok, { status: "aborted", label: "y", reason: "r" }])).toBe(1);
  expect(compactExitCode([{ status: "busy", label: "y" }])).toBe(1);
});

test("a broken file does not stop the batch (deleted meanwhile)", async () => {
  const env = makeEnv();
  const { t, b } = big(env);
  const gone = { ...t, file: `${t.file}.missing`, label: "gone" };
  const llm: CompactLlm = async () => {
    rmSync(t.file); // vanishes before the commit re-read
    return { text: b.slice(0, 5).join("\n"), usage: emptyUsage() };
  };
  const t2 = locationTarget(env.home, "main", "location");
  const res = await compactTargets([t2, gone], llm, { dryRun: false });
  expect(res).toHaveLength(2);
  expect(res[0]?.status).toBe("aborted");
  expect(res[1]?.status).toBe("skipped");
});

test("compacted section keeps the date span; header kept; prose counted; bak holds everything", async () => {
  const env = makeEnv();
  const { t, b } = big(env, "A prose note that is not a bullet.");
  const res = await compactTargets([t], stub(b.slice(0, 10).join("\n")), { dryRun: false });
  expect(res[0]?.status).toBe("compacted");
  const after = readFileSync(t.file, "utf8");
  expect(after).toContain("# location memory\n\nIntro.");
  expect(after).toContain("## compacted 2026-01-01..2026-03-05");
  expect(after).not.toContain("prose note");
  expect(readFileSync(`${t.file}.bak`, "utf8")).toContain("prose note");
  const msg = formatCompactResult(res[0]!);
  expect(msg).toContain("1 non-bullet line(s)");
  expect(msg).toContain("[-] ");
});

test("file without a header: first section is not duplicated, template header used", () => {
  const out = buildCompacted(
    "## 2026-02-02 x\n- one note\n- two note\n",
    "# t\n\nTpl.\n",
    ["- one note"],
    "2026-10-09",
  );
  expect(out.text).toBe("# t\n\nTpl.\n\n## compacted 2026-02-02..2026-02-02\n- one note\n");
  expect(out.text.match(/one note/g)).toHaveLength(1);
});

test("dry-run reply shows sizes and proposed bullets (full for CLI); a real run shows removed/added; hint above 80%", async () => {
  const env = makeEnv();
  const { t, b } = big(env);
  const dry = (await compactTargets([t], stub(b.slice(0, 8).join("\n")), { dryRun: true }))[0]!;
  const text = formatCompactResult(dry);
  expect(text).toContain("DRY RUN");
  expect(text).toContain("[-] ");
  expect(text).not.toContain("# location memory");
  const full = formatCompactResult(dry, { full: true });
  expect(full).toContain("Proposed bullets:");
  expect(full).toContain("- the deploy pipeline step number 7");
  // result stays above 80%: hint
  const stuck = Array.from(
    { length: 14 },
    (_, i) =>
      `- the deploy pipeline step number ${i} uses cache folder alpha${i} ${"x".repeat(200)}`,
  );
  writeFileSync(
    t.file,
    `# location memory\n\n## 2026-01-01 a\n${stuck.join("\n")}\n${"- filler line to stay big\n".repeat(30)}`,
  );
  const llm = stub(stuck.join("\n").replaceAll("x".repeat(200), "x".repeat(200)));
  const r = (await compactTargets([t], llm, { dryRun: true }))[0]!;
  if (r.status === "dry-run" && r.after.chars > 3200)
    expect(formatCompactResult(r)).toContain("Still above 80%");
});

test("sdk call: deadline-safe options (budget, no persistence) are set", async () => {
  const config = loadConfig({ AGENT_HOME: "/tmp/x" });
  let opts: any;
  const llm = sdkCompactLlm(config, async function* (a: any) {
    opts = a.options;
    yield resultMsg({ result: "- a b c" });
  } as any);
  await llm("s", "p");
  expect(opts).toMatchObject({ maxBudgetUsd: 0.05, persistSession: false, tools: [], maxTurns: 1 });
  expect(opts.thinking).toEqual({ type: "disabled" }); // adaptive thinking cost 3-5k output tokens
});

/** Stub SDK stream that never answers and ends with an abort error when its signal fires. */
const hangingQuery = (calls: { n: number }) =>
  async function* (a: any) {
    calls.n++;
    await new Promise((_, rej) =>
      a.options.abortController.signal.addEventListener("abort", () =>
        rej(new Error("Claude Code process aborted by user")),
      ),
    );
    yield resultMsg({ result: "" });
  } as any;

test("sdk call: deadline abort reads 'timed out', is retried once, then aborts the file untouched", async () => {
  const env = makeEnv();
  const { t } = big(env);
  const before = readFileSync(t.file, "utf8");
  const config = loadConfig({ AGENT_HOME: "/tmp/x", TIMEOUT_MS: "20" });
  const calls = { n: 0 };
  const [r] = await compactTargets([t], sdkCompactLlm(config, hangingQuery(calls)), {
    dryRun: false,
  });
  expect(calls.n).toBe(2);
  expect(r).toMatchObject({ status: "aborted", reason: "model call timed out after 0.02 s" });
  expect(readFileSync(t.file, "utf8")).toBe(before);
});

test("sdk call: a timeout then a success is retried; a non-timeout error is not", async () => {
  const config = loadConfig({ AGENT_HOME: "/tmp/x", TIMEOUT_MS: "20" });
  let n = 0;
  const flaky = sdkCompactLlm(config, async function* (a: any) {
    if (++n === 1)
      await new Promise((_, rej) =>
        a.options.abortController.signal.addEventListener("abort", () => rej(new Error("x"))),
      );
    yield resultMsg({ result: "- ok" });
  } as any);
  expect((await flaky("s", "p")).text).toBe("- ok");
  expect(n).toBe(2);
  let m = 0;
  const failing = sdkCompactLlm(config, (() => {
    m++;
    return {
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error("boom")) }),
    };
  }) as any);
  await expect(failing("s", "p")).rejects.toThrow("boom");
  expect(m).toBe(1);
});

test("symlinked memory file: owner forget refused, compaction aborts", async () => {
  const env = makeEnv();
  const t = locationTarget(env.home, "main", "location");
  rmSync(t.file, { force: true });
  writeFileSync(`${t.file}.real`, "# location memory\n");
  symlinkSync(`${t.file}.real`, t.file);
  const run = createMemoryRunner({ db: env.db, config: env.config });
  expect(await run({ channelId: TEST_CHANNEL, text: "forget: should not land" })).toContain(
    "symlink",
  );
  expect(readFileSync(`${t.file}.real`, "utf8")).toBe("# location memory\n");
  writeFileSync(`${t.file}.real`, `# location memory\n\n## d\n${"- ".padEnd(9000, "y")}\n`);
  const res = await compactTargets([t], stub("- a b c"), { dryRun: false });
  expect(res[0]).toMatchObject({ status: "aborted" });
});
