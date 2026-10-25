import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { type BarState, ReactionBar } from "../../src/components/chat/reaction-bar";

afterEach(() => {
  delete (document as { elementFromPoint?: unknown }).elementFromPoint;
});

const state = (extra: Partial<BarState> = {}): BarState => ({
  messageId: 7,
  top: 300,
  bottom: 380,
  down: true,
  origin: { x: 100, y: 340 },
  point: { x: 100, y: 340 },
  ...extra,
});

const handlers = () => ({ onPick: vi.fn(), onMore: vi.fn(), onDismiss: vi.fn() });

test("the bar offers the six emoji and a more item, above the message", () => {
  render(<ReactionBar state={state()} {...handlers()} />);
  const bar = screen.getByRole("toolbar", { name: "Reactions" });
  expect(bar.style.top).toBe("240px");
  expect(bar.className).toBe("rbar");
  expect(screen.getAllByRole("button")).toHaveLength(7);
  expect(screen.getByRole("button", { name: "Reply or copy" })).toBeTruthy();
});

test("a message near the top gets the bar below it", () => {
  render(<ReactionBar state={state({ top: 90, bottom: 150 })} {...handlers()} />);
  const bar = screen.getByRole("toolbar");
  expect(bar.style.top).toBe("158px");
  expect(bar.className).toBe("rbar below");
});

test("while the finger is down the item under it is lifted", () => {
  // The bar is not in the page yet at the first render, so the lookup is lazy and the finger moves once.
  // (jsdom's selector engine cannot match an emoji attribute value, so the item is found by its dataset.)
  document.elementFromPoint = vi.fn(
    () =>
      [...document.querySelectorAll<HTMLElement>("[data-react]")].find(
        (e) => e.dataset.react === "🎉",
      ) ?? null,
  );
  const h = handlers();
  const { rerender } = render(<ReactionBar state={state()} {...h} />);
  rerender(<ReactionBar state={state({ point: { x: 120, y: 340 } })} {...h} />);
  expect(screen.getByRole("button", { name: "React 🎉" }).className).toContain("on");
  expect(screen.getByRole("button", { name: "React 👍" }).className).not.toContain("on");
});

test("with the finger up, a tap picks, more opens the sheet, and the scrim dismisses", () => {
  const h = handlers();
  const { container } = render(<ReactionBar state={state({ down: false })} {...h} />);
  fireEvent.click(screen.getByRole("button", { name: "React ❤️" }));
  expect(h.onPick).toHaveBeenCalledWith("❤️");
  fireEvent.click(screen.getByRole("button", { name: "Reply or copy" }));
  expect(h.onMore).toHaveBeenCalled();
  fireEvent.pointerDown(document.body.querySelector(".rbar-scrim") as Element);
  expect(h.onDismiss).toHaveBeenCalled();
  expect(container).toBeTruthy();
});

test("no scrim while the finger is still down", () => {
  render(<ReactionBar state={state()} {...handlers()} />);
  expect(document.body.querySelector(".rbar-scrim")).toBeNull();
});
