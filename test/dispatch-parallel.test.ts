import { expect, test } from "bun:test";
import { leadHarness, until } from "./lead-harness";

/* Scheduler wired into dispatchReady (fake query): independent items run in parallel, a dependent one waits for both. */

const item = (key: string, dependsOn: string[] = []) => ({
  key,
  subject: `Do ${key}`,
  role: "scout",
  brief: `do ${key}`,
  dependsOn,
});

test("two independent items run at the same time, a dependent one starts only after its dependency completed", async () => {
  let running = 0;
  let peak = 0;
  const started: string[] = [];
  const release: (() => void)[] = [];
  const h = leadHarness(async (c) => {
    if (c.kind === "worker") {
      const key = /do (\w+)/.exec(c.prompt)?.[1] as string;
      started.push(key);
      running++;
      peak = Math.max(peak, running);
      if (key !== "c") await new Promise<void>((r) => release.push(r)); // a and b wait to be released together
      running--;
      await c.report("result", { title: "T", status: "COMPLETED", summary: `${key} ok` });
      return "done";
    }
    if (c.prompt.includes("Owner message:")) {
      const r = await c.orchestrate("dispatch", {
        strategy: "DELEGATE",
        intent: "work",
        reason: "test",
        assignments: [item("a"), item("b"), item("c", ["a"])],
      });
      expect(r.ok).toBe(true);
      return "On it.";
    }
    return "";
  });
  await h.send("do three things");
  await until(() => release.length === 2); // a and b are both running
  expect(peak).toBe(2);
  expect(started).not.toContain("c"); // c waits for a
  for (const r of release) r();
  await until(() => started.includes("c"));
  const goalStatus = () =>
    (
      h.env.db.query("SELECT status FROM owned_tasks WHERE parent_id IS NULL").get() as {
        status: string;
      }
    ).status;
  await until(() => goalStatus() === "completed");
  expect(peak).toBe(2);
});
