import { expect, test } from "bun:test";
import { leadHarness, until } from "./lead-harness";

/* TODO-app scenario with a fake query: owner -> Orchestrate create_plan -> the lead writes a DAG over the ROSTER roles -> one approval ->
   architect -> (designer, scaffold) -> build -> (tester || hacker, parallel) -> writer. A second run: the tester fails. */

const step = (key: string, role: string, dependsOn: string[] = [], risk = "R1") => ({
  key,
  subject: `Do ${key}`,
  role,
  brief: `do ${key}`,
  ...(role === "solution-architect" || role === "hacker" ? {} : { location: "location" }),
  dependsOn,
  risk,
});
const ITEMS = [
  step("arch", "solution-architect", [], "R0"),
  step("design", "designer", ["arch"]),
  step("scaffold", "developer", ["arch"]),
  step("build", "developer", ["design", "scaffold"]),
  step("test", "tester", ["build"]),
  step("audit", "hacker", ["build"], "R0"),
  step("docs", "humanizer-writer", ["test", "audit"]),
];

/** Harness whose lead stores ITEMS, and whose workers run `worker(key)`; the lead approves the plan and ends with `final`. */
function scenario(worker: (key: string) => Promise<"COMPLETED" | "FAILED">, final: RegExp) {
  return leadHarness(
    async (c) => {
      if (c.kind === "worker") {
        // The code-appended items have no `do <key>` brief: "Verify the goal: ..." and "Fix the goal: ...".
        const key =
          /^do (\w+)/m.exec(c.prompt)?.[1] ??
          (c.prompt.includes("Acceptance criteria:") ? "verify" : "fix");
        const status = await worker(key);
        await c.report("result", { title: "T", status, summary: `${key} ${status}` });
        return "worker done";
      }
      if (c.prompt.includes("<owner_message>\nbuild a todo app")) {
        const made = await c.orchestrate("create_plan", {
          objective: "build a todo app",
          items: ITEMS,
          acceptanceCriteria: ["the app runs"],
          envelope: {
            locations: ["location"],
            riskClasses: ["R0", "R1"],
            bounds: { maxItems: 8, maxGb: 1 },
          },
          effects: [],
        });
        expect(made).toMatchObject({ ok: true, status: "valid" });
        await c.orchestrate("approve_plan", { planId: made.planId, version: 1 });
        return "Plan approved, running.";
      }
      return final.test(c.prompt) ? "Final report." : "";
    },
    undefined,
    { askChoice: async () => "Approve plan" },
  );
}

test("the roster runs a DAG: tester and hacker overlap, everything else follows its dependencies, the goal completes", async () => {
  const started: string[] = [];
  const finished: string[] = [];
  let gate!: () => void;
  const both = new Promise<void>((r) => (gate = r));
  const h = scenario(async (key) => {
    started.push(key);
    if (key === "test" || key === "audit") {
      // Each waits for the other: a sequential scheduler would deadlock here.
      if (started.includes("test") && started.includes("audit")) gate();
      await both;
    }
    finished.push(key);
    return "COMPLETED";
  }, /"key":"verify-1"/);
  await h.send("build a todo app");
  await until(() => h.posts.includes("Final report."), 20000);
  const at = (k: string) => finished.indexOf(k);
  // Dependency order: every item finished after the ones it waits for.
  for (const it of ITEMS) for (const d of it.dependsOn) expect(at(d)).toBeLessThan(at(it.key));
  expect(started.slice(-2)).toEqual(["docs", "verify"]); // the verify item runs last, after every item
  expect(h.env.db.query("SELECT status FROM owned_tasks WHERE parent_id IS NULL").all()).toEqual([
    { status: "completed" },
  ]);
});

test("a failing tester is held: its dependent `docs` waits, the hacker's result stays, the goal stays open, the lead is told", async () => {
  const h = scenario(async (key) => (key === "test" ? "FAILED" : "COMPLETED"), /FAILED|failure/);
  await h.send("build a todo app");
  await until(() => h.posts.includes("Final report."), 20000);
  const rows = h.env.db
    .query("SELECT item_key AS k, status FROM owned_tasks WHERE parent_id IS NOT NULL")
    .all() as { k: string; status: string }[];
  const by = Object.fromEntries(rows.map((r) => [r.k, r.status]));
  expect(by).toMatchObject({
    test: "blocked",
    docs: "pending",
    audit: "completed",
    build: "completed",
  });
  // Held, not decided: the goal is still open until the lead retries or cancels.
  expect(
    (h.env.db.query("SELECT status FROM owned_tasks WHERE parent_id IS NULL").get() as any)?.status,
  ).toBe("open");
});

test("verify FAILED once: code appends fix-1 and verify-2, the fix runs, the second verify passes, the goal completes", async () => {
  const ran: string[] = [];
  let verifies = 0;
  const h = scenario(async (key) => {
    ran.push(key);
    if (key === "verify") return ++verifies === 1 ? "FAILED" : "COMPLETED";
    return "COMPLETED";
  }, /"key":"verify-2"/);
  await h.send("build a todo app");
  await until(() => h.posts.includes("Final report."), 20000);
  expect(ran.slice(-3)).toEqual(["verify", "fix", "verify"]); // verify, the fix, the re-check
  const rows = h.env.db
    .query(
      "SELECT item_key AS k, status FROM owned_tasks WHERE item_key LIKE 'verify%' OR item_key LIKE 'fix%'",
    )
    .all();
  expect(rows).toEqual([
    { k: "verify-1", status: "cancelled" },
    { k: "fix-1", status: "completed" },
    { k: "verify-2", status: "completed" },
  ]);
  expect(h.env.db.query("SELECT status FROM owned_tasks WHERE parent_id IS NULL").all()).toEqual([
    { status: "completed" },
  ]);
});
