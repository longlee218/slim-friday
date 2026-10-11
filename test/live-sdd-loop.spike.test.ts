import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { GIT_MCP_SERVER, GIT_TOOL, mcpToolName } from "../src/mcp/mcp-tool-names";
import {
  AGENT_TOOL_NAME,
  BASH_TOOL_NAME,
  EDIT_TOOL_NAME,
  MULTI_EDIT_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  WRITE_TOOL_NAME,
} from "../src/tools/sdk-tool-names";
import { AUTHOR, BUDGET, CONVENTIONAL, git, RUN, runLoop, TIMEOUT } from "./live-sdd-loop-helpers";

// Gated live test of the A2 loop: the UNMODIFIED subagent-driven-development skill drives a tiny 3-task plan in a temp
// git clone through the REAL dev exec stage options (guard, hooks, registry, skills plugin, git MCP). It costs money.
//
// OPT-IN: SPIKE_SDD_LOOP=1 (local Claude login, Haiku for the main agent and every subagent).
//   SPIKE_SDD_LOOP=1 [SPIKE_SDD_BUDGET_USD=1.5] [SPIKE_SDD_TIMEOUT_MS=900000] bun test test/live-sdd-loop.spike.test.ts
// Budget: maxBudgetUsd of the run = SPIKE_SDD_BUDGET_USD (default 0.5), the stage's own 3.0 is capped by it. A full
// 3-task loop with 3 implementers, 3 reviewers and one resume may need more than the default: a budget stop fails the
// "run succeeded" assertion first (the later ones then describe a partial loop). Never run in CI.
//

describe.skipIf(!RUN)(
  "live SDD loop (Haiku, real exec stage options, gated by SPIKE_SDD_LOOP)",
  () => {
    test(
      "3-task plan: scripts run, mapped dispatch, clean commits, reviewer read-only, resume, no stall",
      async () => {
        const { res, lines, clone, baseSha } = await runLoop();

        const ev = (e: string) => lines.filter((l) => l.event === e);
        const spawned = ev("subagent.spawned");
        const denied = ev("tool.denied");
        const done = ev("tool.done");
        const commits = git(clone, "log", "--format=%an|%ae|%s|%b%x1e", `${baseSha}..HEAD`)
          .split("\x1e")
          .map((c) => c.trim())
          .filter(Boolean);
        const summary = {
          outcome: res.outcome,
          costUsd: res.usage.costUsd,
          budgetUsd: BUDGET,
          turns: res.usage.turns,
          spawns: spawned.map(
            (s) => `${s.subagentType}:${s.name}:${s.modelAsked}->${s.modelResolved}`,
          ),
          resumes: ev("subagent.resume").length,
          commits: commits.length,
          denies: denied.map(
            (d) => `${d.agentType ?? "main"}|${d.tool}|${String(d.reason).slice(0, 80)}`,
          ),
        };
        process.stderr.write(`[sdd-loop summary] ${JSON.stringify(summary, null, 2)}\n`);

        // 1. The run itself finished (a budget stop is reported by its outcome, raise SPIKE_SDD_BUDGET_USD).
        expect(res.outcome).toBe("success");

        // 2. The skill's scripts ran from the main agent (task-brief at least once, no denial of a script).
        const scriptRuns = done.filter(
          (l) =>
            l.tool === BASH_TOOL_NAME &&
            !l.agentId &&
            String(l.target).includes("scripts/task-brief") &&
            l.ok,
        );
        expect(scriptRuns.length).toBeGreaterThanOrEqual(1);
        expect(
          denied.filter(
            (d) => !d.agentId && d.tool === BASH_TOOL_NAME && String(d.target).includes("scripts/"),
          ),
        ).toEqual([]);

        // 3. Dispatch uses the mapped types only: implementer and task-reviewer, never general-purpose; every spawn
        //    carries a name and a model.
        const types = new Set(spawned.map((s) => s.subagentType));
        expect(types.has("implementer")).toBe(true);
        expect(types.has("task-reviewer")).toBe(true);
        for (const t of types)
          expect(["explorer", "implementer", "task-reviewer"]).toContain(String(t));
        for (const s of spawned) {
          expect(s.name).toBeTruthy();
          expect(s.modelAsked).toBeTruthy();
        }
        expect(
          denied.filter(
            (d) => d.tool === AGENT_TOOL_NAME && String(d.reason).includes("is not available"),
          ),
        ).toEqual([]);

        // 4. Commits are clean: one per task at least, the owner identity, conventional subject, no AI attribution; tests pass.
        expect(commits.length).toBeGreaterThanOrEqual(3);
        for (const c of commits) {
          expect(c.startsWith(`${AUTHOR.name}|${AUTHOR.email}|`)).toBe(true);
          expect(c.split("|").slice(2).join("|")).toMatch(CONVENTIONAL);
          expect(c).not.toMatch(/co-authored-by|generated (with|by)|claude|anthropic/i);
        }
        expect(git(clone, "status", "--porcelain").trim()).toBe(""); // the SDD workspace ignores itself
        expect(() => execFileSync("bun", ["test"], { cwd: clone, stdio: "pipe" })).not.toThrow();

        // 5. A reviewer never changed anything: no write, shell or commit call of a task-reviewer completed.
        const reviewerMutations = done.filter(
          (l) =>
            l.agentType === "task-reviewer" &&
            [
              WRITE_TOOL_NAME,
              EDIT_TOOL_NAME,
              MULTI_EDIT_TOOL_NAME,
              BASH_TOOL_NAME,
              mcpToolName(GIT_MCP_SERVER, GIT_TOOL.ADD),
              mcpToolName(GIT_MCP_SERVER, GIT_TOOL.COMMIT),
            ].includes(String(l.tool)),
        );
        expect(reviewerMutations).toEqual([]);

        // 6. Resume worked: SendMessage was allowed (named target), and that subagent started again with the same id.
        expect(ev("subagent.resume").length).toBeGreaterThanOrEqual(1);
        expect(denied.filter((d) => d.tool === SEND_MESSAGE_TOOL_NAME)).toEqual([]);
        const starts = ev("subagent.start").map((l) => String(l.agentId));
        expect(starts.length).toBeGreaterThan(new Set(starts).size); // an id seen twice = a resumed subagent

        // 7. No denial-triggered stall: few denials, and none repeated (a model looping on a denied call).
        const repeats = new Map<string, number>();
        for (const d of denied) {
          const k = `${d.agentType ?? "main"}|${d.tool}|${d.target}`;
          repeats.set(k, (repeats.get(k) ?? 0) + 1);
        }
        expect([...repeats.entries()].filter(([, n]) => n > 2)).toEqual([]);
        expect(denied.filter((d) => d.agentId).length).toBeLessThan(6);
        // The implementer's test command is never denied (the allowlist reaches subagents).
        expect(
          denied.filter(
            (d) => d.agentType === "implementer" && String(d.target).startsWith("bun test"),
          ),
        ).toEqual([]);
      },
      TIMEOUT + 60_000,
    );
  },
);
