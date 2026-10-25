import { expect, test } from "bun:test";
import { FakeStore } from "../../../core/test/fakes/fake-store";
import type { ScratchpadContext } from "../../src/scratchpad/scratchpad-context";
import { scratchpadServer } from "../../src/scratchpad/scratchpad-server";
import { createScratchpadAddTool } from "../../src/scratchpad/tools/ScratchpadAddTool/scratchpad-add-tool";
import { createScratchpadCompleteTool } from "../../src/scratchpad/tools/ScratchpadCompleteTool/scratchpad-complete-tool";
import { createScratchpadListTool } from "../../src/scratchpad/tools/ScratchpadListTool/scratchpad-list-tool";
import { createScratchpadRemoveTool } from "../../src/scratchpad/tools/ScratchpadRemoveTool/scratchpad-remove-tool";
import { createScratchpadUpdateTool } from "../../src/scratchpad/tools/ScratchpadUpdateTool/scratchpad-update-tool";
import { call, textOf } from "../design-fixture";

/** All five tools for one scope over a shared fake store. */
function make(scopeKey = "ann", store = new FakeStore()) {
  const ctx: ScratchpadContext = { botId: "ann", scopeKey, store, now: () => 1000 };
  return {
    store,
    add: createScratchpadAddTool(ctx),
    list: createScratchpadListTool(ctx),
    update: createScratchpadUpdateTool(ctx),
    complete: createScratchpadCompleteTool(ctx),
    remove: createScratchpadRemoveTool(ctx),
  };
}

test("add, list, update, complete and remove work on the scope's items", async () => {
  const t = make();
  const added = await call(t.add, { title: "write report", notes: "draft first" });
  expect(added.isError).toBeUndefined();
  expect(textOf(added)).toContain("pad1");
  expect(textOf(await call(t.list, {}))).toContain("write report");
  await call(t.update, { itemId: "pad1", status: "parked", notes: "waiting" });
  const parked = textOf(await call(t.list, {}));
  expect(parked).toContain("parked");
  expect(parked).toContain("waiting");
  expect((await call(t.complete, { itemId: "pad1" })).isError).toBeUndefined();
  // Done items are listed only on request.
  expect(textOf(await call(t.list, {}))).not.toContain("write report");
  expect(textOf(await call(t.list, { includeDone: true }))).toContain("write report");
  expect((await call(t.remove, { itemId: "pad1" })).isError).toBeUndefined();
  expect(t.store.padItems).toEqual([]);
});

test("a missing id is a readable error", async () => {
  const t = make();
  for (const [tool, args] of [
    [t.update, { itemId: "nope", title: "x" }],
    [t.complete, { itemId: "nope" }],
    [t.remove, { itemId: "nope" }],
  ] as const) {
    const r = await call(tool, args);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("nope");
  }
});

test("title and notes limits are refused with the limit named, nothing stored", async () => {
  const t = make();
  const longTitle = await call(t.add, { title: "t".repeat(201) });
  expect(longTitle.isError).toBe(true);
  expect(textOf(longTitle)).toContain("200");
  const longNotes = await call(t.add, { title: "ok", notes: "n".repeat(4001) });
  expect(longNotes.isError).toBe(true);
  expect(textOf(longNotes)).toContain("4000");
  expect((await call(t.add, { title: "  " })).isError).toBe(true);
  expect((await call(t.add, { title: "t".repeat(200), notes: "n".repeat(4000) })).isError).toBe(
    undefined,
  );
  expect(t.store.padItems.length).toBe(1);
  const upd = await call(t.update, { itemId: "pad1", title: "t".repeat(201) });
  expect(upd.isError).toBe(true);
  expect((await call(t.update, { itemId: "pad1", notes: "n".repeat(4001) })).isError).toBe(true);
});

test("a 41st live item is refused and tells the bot to complete or remove one", async () => {
  const t = make();
  for (let i = 0; i < 40; i++) await call(t.add, { title: `job ${i}` });
  const over = await call(t.add, { title: "one too many" });
  expect(over.isError).toBe(true);
  expect(textOf(over)).toMatch(/complete or remove/i);
  // Done items do not count; completing one frees a place.
  await call(t.complete, { itemId: "pad1" });
  expect((await call(t.add, { title: "fits now" })).isError).toBeUndefined();
  // Reopening a done item past the cap is refused too.
  const reopen = await call(t.update, { itemId: "pad1", status: "open" });
  expect(reopen.isError).toBe(true);
});

test("each tool reaches only its own scope", async () => {
  const direct = make("ann");
  const group = make("ann@g", direct.store);
  await call(direct.add, { title: "direct only" });
  await call(group.add, { title: "group only" });
  expect(textOf(await call(direct.list, {}))).not.toContain("group only");
  expect(textOf(await call(group.list, {}))).not.toContain("direct only");
  // The other scope's id cannot be updated, completed or removed.
  expect((await call(group.update, { itemId: "pad1", title: "x" })).isError).toBe(true);
  expect((await call(group.complete, { itemId: "pad1" })).isError).toBe(true);
  expect((await call(group.remove, { itemId: "pad1" })).isError).toBe(true);
  expect(direct.store.padItems.length).toBe(2);
});

test("the server offers the five tools", () => {
  const ctx: ScratchpadContext = {
    botId: "ann",
    scopeKey: "ann",
    store: new FakeStore(),
    now: () => 1,
  };
  expect(scratchpadServer(ctx).name).toBe("scratchpad");
});
