import { expect, test } from "vitest";
import {
  ACTION_PX,
  type RowSwipe,
  rowSwipeStep,
  settlesOpen,
} from "../../src/components/phone/swipe-to-delete";

const press = (): RowSwipe => ({ phase: "pressing", dx: 0 });

test("row swipe: vertical first cancels, leftwards clamps at -80, rightwards stays 0", () => {
  expect(rowSwipeStep(press(), { dx: -3, dy: 12 }).phase).toBe("cancelled");
  expect(rowSwipeStep(press(), { dx: -200, dy: 0 })).toEqual({ phase: "swiping", dx: -ACTION_PX });
  expect(rowSwipeStep(press(), { dx: 40, dy: 0 }).dx).toBe(0);
});

test("row swipe: an open row starts from -80 and slides back with a rightward drag", () => {
  expect(rowSwipeStep(press(), { dx: 30, dy: 0 }, -ACTION_PX).dx).toBe(-50);
});

test("row swipe: under the slop it is still a press; a cancelled one stays cancelled", () => {
  expect(rowSwipeStep(press(), { dx: -5, dy: 0 }).phase).toBe("pressing");
  const c = rowSwipeStep(press(), { dx: 0, dy: 20 });
  expect(rowSwipeStep(c, { dx: -90, dy: 0 })).toBe(c);
});

test("a release at half the action width or further settles open", () => {
  expect(settlesOpen(-40)).toBe(true);
  expect(settlesOpen(-39)).toBe(false);
});
