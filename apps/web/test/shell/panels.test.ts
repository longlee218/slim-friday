import { expect, test } from "vitest";
import { type Panels, panelsForWidth, togglePanel } from "../../src/components/shell/panels";

const open = (p: Panels) => [p.sidebar.open, p.inspector.open];

test("first layout at 1200 opens both, at 1000 only the sidebar, at 800 neither", () => {
  expect(open(panelsForWidth(1200, null))).toEqual([true, true]);
  expect(open(panelsForWidth(1000, null))).toEqual([true, false]);
  expect(open(panelsForWidth(800, null))).toEqual([false, false]);
});

test("crossing 1180 down closes the inspector, back up reopens it", () => {
  const a = panelsForWidth(1200, null);
  const b = panelsForWidth(1100, a);
  expect(open(b)).toEqual([true, false]);
  expect(open(panelsForWidth(1200, b))).toEqual([true, true]);
});

test("resize without crossing keeps a hand-closed sidebar closed", () => {
  const closed = togglePanel(panelsForWidth(1000, null), "sidebar", 1000);
  expect(closed.sidebar.open).toBe(false);
  expect(panelsForWidth(1050, closed).sidebar.open).toBe(false);
});

test("crossing resets floating", () => {
  const floating = togglePanel(panelsForWidth(1000, null), "inspector", 1000);
  expect(panelsForWidth(1200, floating).inspector).toEqual({ open: true, floating: false });
});

test("opening the inspector below 1180 floats it", () => {
  expect(togglePanel(panelsForWidth(1000, null), "inspector", 1000).inspector).toEqual({
    open: true,
    floating: true,
  });
});

test("opening inside the band does not float; closing clears floating", () => {
  const p = togglePanel(panelsForWidth(1200, null), "inspector", 1200);
  expect(p.inspector).toEqual({ open: false, floating: false });
  expect(togglePanel(p, "inspector", 1200).inspector).toEqual({ open: true, floating: false });
});

test("below 640 is phone", () => {
  expect(panelsForWidth(639, null).mode).toBe("phone");
  expect(panelsForWidth(640, null).mode).toBe("desktop");
});
