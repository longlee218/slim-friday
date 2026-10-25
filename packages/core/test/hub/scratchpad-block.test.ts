import { expect, test } from "bun:test";
import type { ScratchpadItem } from "../../src";
import { scratchpadBlock } from "../../src/hub/scratchpad-block";
import { flush, makeHub } from "../bot-hub-harness";

/** An item with defaults. */
const item = (n: number, over: Partial<ScratchpadItem> = {}): ScratchpadItem => ({
  id: `pad${n}`,
  scopeKey: "ann",
  botId: "ann",
  title: `title ${n}`,
  status: "open",
  notes: "",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

test("no items: no block", () => {
  expect(scratchpadBlock([])).toBeUndefined();
});

test("lines carry id, status, title and the first line of the notes; text is escaped", () => {
  const text =
    scratchpadBlock([
      item(1, { notes: "first <b>\nsecond" }),
      item(2, { status: "parked", title: "a & b" }),
    ]) ?? "";
  expect(text).toStartWith("Open scratchpad items for this bot follow.");
  expect(text).toContain("Friday");
  expect(text).toContain("<scratchpad_open>\n- [pad1] open title 1: first &lt;b&gt;\n");
  expect(text).toContain("- [pad2] parked a &amp; b\n</scratchpad_open>");
  expect(text).not.toContain("second");
});

test("at most 40 items, then a more line", () => {
  const text = scratchpadBlock(Array.from({ length: 45 }, (_, i) => item(i))) ?? "";
  expect(text.match(/^- \[/gm)?.length).toBe(40);
  expect(text).toContain("…and 5 more. Call ScratchpadList");
  expect(text.indexOf("…and 5 more")).toBeLessThan(text.indexOf("</scratchpad_open>"));
});

test("at most 4 KB, the cut is counted in the more line", () => {
  const items = Array.from({ length: 30 }, (_, i) =>
    item(i, { title: "t".repeat(200), notes: "n".repeat(200) }),
  );
  const text = scratchpadBlock(items) ?? "";
  expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(4096);
  const shown = text.match(/^- \[/gm)?.length ?? 0;
  expect(shown).toBeGreaterThan(0);
  expect(text).toContain(`…and ${30 - shown} more. Call ScratchpadList`);
});

test("a group session's block holds only its scope, the direct one only its own", async () => {
  const { runtime, surface, store } = makeHub();
  const add = (scopeKey: string, title: string) =>
    store.scratchpad.add({ scopeKey, botId: "editor", title, status: "open", notes: "" }, 1);
  await add("editor", "direct job");
  await add("editor@g", "group job");
  await add("writer@g", "writer group job");
  surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  const direct = runtime.last().spec.scratchpad ?? "";
  expect(direct).toContain("direct job");
  expect(direct).not.toContain("group job");
  runtime.last().emit({ type: "turn_end", costUsd: 0 });
  await flush();
  surface.deliver({ conversationId: "gc", text: "hi all" });
  await flush();
  const group = runtime.last().spec.scratchpad ?? "";
  expect(group).toContain("writer group job");
  expect(group).not.toContain("direct job");
  expect(group).not.toContain("- [pad2]");
});

test("done items are not injected; none open means no block", async () => {
  const { runtime, surface, store } = makeHub();
  await store.scratchpad.add(
    { scopeKey: "editor", botId: "editor", title: "old", status: "done", notes: "" },
    1,
  );
  surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  expect(runtime.last().spec.scratchpad).toBeUndefined();
});
