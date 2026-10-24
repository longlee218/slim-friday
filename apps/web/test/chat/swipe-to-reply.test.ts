import { expect, test } from "vitest";
import {
  HOLD_MS,
  movedPastSlop,
  SWIPE_PX,
  type SwipeState,
  swipeStep,
} from "../../src/components/chat/swipe-to-reply";

const press = (): SwipeState => ({ phase: "pressing", dx: 0, ok: false });

test("swipe: past 56 px is ok, vertical first cancels", () => {
  expect(swipeStep(press(), { dx: 60, dy: 2 })).toMatchObject({ phase: "swiping", ok: true });
  expect(swipeStep(press(), { dx: 3, dy: 12 }).phase).toBe("cancelled");
  expect(swipeStep(press(), { dx: 120, dy: 0 }).dx).toBe(80);
});

test("swipe: exactly 56 px is not yet ok, leftwards stays at 0", () => {
  expect(swipeStep(press(), { dx: SWIPE_PX, dy: 0 }).ok).toBe(false);
  expect(swipeStep(press(), { dx: -30, dy: 0 }).dx).toBe(0);
});

test("swipe: a swipe under way ignores vertical drift; a cancelled one stays cancelled", () => {
  const s = swipeStep(press(), { dx: 40, dy: 0 });
  expect(swipeStep(s, { dx: 44, dy: 30 }).phase).toBe("swiping");
  const c = swipeStep(press(), { dx: 0, dy: 20 });
  expect(swipeStep(c, { dx: 90, dy: 20 })).toBe(c);
});

test("any move over 8 px cancels the hold", () => {
  expect(movedPastSlop({ dx: 3, dy: 4 })).toBe(false);
  expect(movedPastSlop({ dx: 9, dy: 0 })).toBe(true);
  expect(movedPastSlop({ dx: 0, dy: -9 })).toBe(true);
  expect(HOLD_MS).toBe(450);
});

test("once swiping, dragging back to 0 and drifting vertically does not cancel", () => {
  const swiping = swipeStep(press(), { dx: 40, dy: 0 });
  const back = swipeStep(swiping, { dx: 0, dy: 0 });
  expect(back.phase).toBe("swiping");
  expect(swipeStep(back, { dx: 1, dy: 30 }).phase).toBe("swiping");
});
