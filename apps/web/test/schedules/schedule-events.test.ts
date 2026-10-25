import { QueryClient } from "@tanstack/react-query";
import { expect, test, vi } from "vitest";
import { orpc } from "../../src/api/client";
import { applyEffects } from "../../src/events/apply-effects";
import { reduceEvent } from "../../src/events/event-reducer";

const view = { activeConversationId: null, visible: true, now: 1 };

test("a schedule event becomes an invalidate of the schedules scope", () => {
  expect(reduceEvent({ type: "schedule", id: "s1" }, view)).toEqual([
    { op: "invalidate", scope: "schedules" },
  ]);
});

test("the schedules invalidate refetches a cached list without a reload", () => {
  const qc = new QueryClient();
  qc.setQueryData(orpc.schedules.list.queryKey({ input: {} }), { items: [] });
  const spy = vi.spyOn(qc, "invalidateQueries");
  applyEffects(qc, [{ op: "invalidate", scope: "schedules" }], () => {});
  expect(spy).toHaveBeenCalledWith({ queryKey: orpc.schedules.key() });
  expect(qc.getQueryState(orpc.schedules.list.queryKey({ input: {} }))?.isInvalidated).toBe(true);
});
