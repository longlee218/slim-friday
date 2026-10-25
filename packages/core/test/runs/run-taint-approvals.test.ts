import { expect, test } from "bun:test";
import { flush, makeHub } from "../bot-hub-harness";

/** A read-only tool and a write tool (balanced asks by class) of one external MCP server. */
const SEARCH = { tool: "mcp__ext__search", input: { q: "a" } };
const SAVE = { tool: "mcp__ext__save", input: { v: 1 } };
type Hub = ReturnType<typeof makeHub>;

/** A hub where editor may use the `ext` server (so a resumed run's one shot is honoured). */
function hub(): Hub {
  const h = makeHub();
  h.editor.tools = ["mcp__ext"];
  h.catalog.tools = [
    { name: SEARCH.tool, annotations: { readOnlyHint: true } },
    { name: SAVE.tool, annotations: { destructiveHint: false, openWorldHint: false } },
  ];
  return h;
}
const cards = (h: Hub) => [...h.store.cardMap.values()];

test("a clean-run approval replayed as the one shot of the tainted resume is no taint approval", async () => {
  const h = hub();
  h.surface.deliver({ conversationId: "dc", text: "save it" });
  await flush();
  const s = h.runtime.last();
  const d = await s.spec.decide(SAVE);
  expect(d.behavior).toBe("park");
  await flush();
  await h.hub.answerCard(d.behavior === "park" ? d.cardId : "", "once");
  await flush();
  const r = h.runtime.last();
  expect(r).not.toBe(s);
  // The exact approved call first: the one shot allows it.
  expect(await r.spec.decide(SAVE)).toEqual({ behavior: "allow" });
  expect(cards(h).map((c) => c.status)).toEqual(["used"]);
  // The resumed run is tainted: the server's first tainted call still gets a taint card.
  const d2 = await r.spec.decide(SEARCH);
  expect(d2.behavior).toBe("park");
  expect(cards(h)[1]?.approval).toMatchObject({ tool: SEARCH.tool, tainted: true });
});

test("a clean-run card answered in place after the run became tainted is no taint approval", async () => {
  const h = hub();
  h.surface.deliver({ conversationId: "dc", text: "save it" });
  await flush();
  const s = h.runtime.last();
  s.emit({ type: "task_started", taskId: "t1", description: "dig" });
  await flush();
  const d = s.spec.decide(SAVE);
  await flush();
  const id = cards(h)[0]?.id ?? "";
  expect(cards(h)[0]?.approval?.tainted).toBeUndefined();
  // While the run waits on the card, a Read result taints it.
  s.emit({ type: "tool_call", toolUseId: "u1", tool: "Bash", input: {} });
  s.emit({ type: "tool_result", toolUseId: "u1", ok: true });
  await flush();
  expect(await h.hub.answerCard(id, "once")).toBe("ok");
  expect(await d).toEqual({ behavior: "allow" });
  // Not awaited: the new card waits in place too (the task still runs).
  void s.spec.decide(SEARCH);
  await flush();
  expect(cards(h)).toHaveLength(2);
  expect(cards(h)[1]?.approval).toMatchObject({ tool: SEARCH.tool, tainted: true });
});
