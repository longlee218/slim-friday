import { expect, test } from "bun:test";
import { type PageHandle, type PageStep, runSteps } from "../../src/computer/browser/page-act";

/** A page whose `send` counts the input events it receives; `failOn` makes the nth one throw. */
function page(failOn = 0) {
  const sent: string[] = [];
  const handle: PageHandle = {
    gen: 5,
    contextId: 1,
    sleep: async () => {},
    send: (async (method: string) => {
      sent.push(method);
      if (sent.length === failOn) throw new Error("boom");
      return {};
    }) as never,
  };
  return { handle, sent };
}

const scroll: PageStep = { kind: "scroll", dy: 10 };

test("a stale ref at step 3 of 3 refuses the batch before any step runs", async () => {
  const p = page();
  const steps: PageStep[] = [scroll, scroll, { kind: "click", ref: "p4:0" }];
  await expect(runSteps(p.handle, steps)).rejects.toThrow("older snapshot");
  expect(p.sent).toEqual([]);
});

test("a failing step 2 of 3 stops the batch with one uncertain report", async () => {
  const p = page(2);
  const out = await runSteps(p.handle, [scroll, scroll, scroll]);
  expect(p.sent).toHaveLength(2);
  expect(out).toContain("done 1 of 3; uncertain: true");
  expect(out.match(/done \d+ of/g)).toHaveLength(1);
});

test("beforeStep runs before each step and a throw names the steps done", async () => {
  const p = page();
  let calls = 0;
  const ok = await runSteps(p.handle, [scroll, scroll, scroll], async () => void calls++);
  expect(calls).toBe(3);
  expect(ok).toContain("done 3 of 3");
  let n = 0;
  const hook = async () => {
    if (++n === 3) throw new Error("lease lost");
  };
  await expect(runSteps(page().handle, [scroll, scroll, scroll], hook)).rejects.toThrow(
    "lease lost after 2 of 3 steps",
  );
});
