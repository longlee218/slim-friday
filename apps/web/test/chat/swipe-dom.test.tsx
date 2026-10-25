import { act, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import {
  type Point,
  type SwipeHandlers,
  useSwipeToReply,
} from "../../src/components/chat/swipe-to-reply";

afterEach(() => vi.useRealTimers());

/** A scroller with one bot message (id 7) wired to the hook. */
function Host({
  onReply,
  onHold,
  ...more
}: { onReply(id: number): void; onHold(id: number, at: Point): void } & Partial<SwipeHandlers>) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  useSwipeToReply(el, { onReply, onHold, ...more });
  return (
    <div ref={setEl} data-testid="scroller">
      <div className="msg" data-mi="7">
        <span data-testid="text">hello</span>
        <button type="button">act</button>
      </div>
    </div>
  );
}

const press = (el: Element, x: number, y = 100) =>
  fireEvent.pointerDown(el, { clientX: x, clientY: y, pointerId: 1 });

test("release past 56 px replies; a short drag does not", () => {
  const onReply = vi.fn();
  const { getByTestId } = render(<Host onReply={onReply} onHold={vi.fn()} />);
  const text = getByTestId("text");
  press(text, 100);
  fireEvent.pointerMove(text, { clientX: 130, clientY: 100 });
  fireEvent.pointerUp(text);
  expect(onReply).not.toHaveBeenCalled();
  press(text, 100);
  fireEvent.pointerMove(text, { clientX: 170, clientY: 101 });
  expect(text.closest(".msg")?.classList.contains("swipe-ok")).toBe(true);
  fireEvent.pointerUp(text);
  expect(onReply).toHaveBeenCalledWith(7);
});

test("a press near the left edge or on a button is ignored", () => {
  const onReply = vi.fn();
  const { getByTestId, getByRole } = render(<Host onReply={onReply} onHold={vi.fn()} />);
  press(getByTestId("text"), 10);
  fireEvent.pointerMove(getByTestId("text"), { clientX: 120, clientY: 100 });
  fireEvent.pointerUp(getByTestId("text"));
  press(getByRole("button"), 100);
  fireEvent.pointerMove(getByRole("button"), { clientX: 190, clientY: 100 });
  fireEvent.pointerUp(getByRole("button"));
  expect(onReply).not.toHaveBeenCalled();
});

test("holding 450 ms opens the bar; vertical movement cancels", () => {
  vi.useFakeTimers();
  const onHold = vi.fn();
  const { getByTestId } = render(<Host onReply={vi.fn()} onHold={onHold} />);
  const text = getByTestId("text");
  press(text, 100);
  act(() => vi.advanceTimersByTime(450));
  expect(onHold).toHaveBeenCalledWith(7, { x: 100, y: 100 });
  press(text, 100);
  fireEvent.pointerMove(text, { clientX: 101, clientY: 130 });
  act(() => vi.advanceTimersByTime(600));
  expect(onHold).toHaveBeenCalledTimes(1);
});

test("a tap with a little drift leaves the bubble alone: no cue, no inline style", () => {
  vi.useFakeTimers();
  const { getByTestId } = render(<Host onReply={vi.fn()} onHold={vi.fn()} />);
  const text = getByTestId("text");
  const msg = text.closest<HTMLElement>(".msg");
  press(text, 100);
  fireEvent.pointerMove(text, { clientX: 104, clientY: 101 });
  act(() => vi.advanceTimersByTime(100));
  expect(msg?.classList.contains("holding")).toBe(false);
  expect(msg?.style.transform).toBe("");
  fireEvent.pointerUp(text);
  expect(msg?.getAttribute("style")).toBeNull();
});

test("the press cue shows only after 150 ms of holding still", () => {
  vi.useFakeTimers();
  const { getByTestId } = render(<Host onReply={vi.fn()} onHold={vi.fn()} />);
  const text = getByTestId("text");
  press(text, 100);
  act(() => vi.advanceTimersByTime(149));
  expect(text.closest(".msg")?.classList.contains("holding")).toBe(false);
  act(() => vi.advanceTimersByTime(1));
  expect(text.closest(".msg")?.classList.contains("holding")).toBe(true);
  fireEvent.pointerUp(text);
  expect(text.closest(".msg")?.classList.contains("holding")).toBe(false);
});

test("after a hold the finger keeps reporting until it lifts, and the page does not scroll", () => {
  vi.useFakeTimers();
  const onMove = vi.fn();
  const onEnd = vi.fn();
  const onReply = vi.fn();
  const { getByTestId } = render(
    <Host onReply={onReply} onHold={vi.fn()} onHoldMove={onMove} onHoldEnd={onEnd} />,
  );
  const text = getByTestId("text");
  press(text, 100);
  act(() => vi.advanceTimersByTime(450));
  fireEvent.pointerMove(text, { clientX: 180, clientY: 60 });
  expect(onMove).toHaveBeenCalledWith({ x: 180, y: 60 });
  const touch = new Event("touchmove", { bubbles: true, cancelable: true });
  text.dispatchEvent(touch);
  expect(touch.defaultPrevented).toBe(true);
  fireEvent.pointerUp(text, { clientX: 180, clientY: 60 });
  expect(onEnd).toHaveBeenCalledWith({ x: 180, y: 60 });
  expect(onReply).not.toHaveBeenCalled();
  // The hold is over: a later touchmove scrolls as usual.
  const after = new Event("touchmove", { bubbles: true, cancelable: true });
  text.dispatchEvent(after);
  expect(after.defaultPrevented).toBe(false);
});

test("after a hold, a finger over the bar outside the scroller still moves and lifts", () => {
  vi.useFakeTimers();
  const onMove = vi.fn();
  const onEnd = vi.fn();
  const { getByTestId } = render(
    <Host onReply={vi.fn()} onHold={vi.fn()} onHoldMove={onMove} onHoldEnd={onEnd} />,
  );
  const outside = document.createElement("div");
  document.body.append(outside);
  press(getByTestId("text"), 100);
  act(() => vi.advanceTimersByTime(450));
  fireEvent.pointerMove(outside, { clientX: 220, clientY: 40 });
  fireEvent.pointerUp(outside, { clientX: 220, clientY: 40 });
  expect(onMove).toHaveBeenCalledWith({ x: 220, y: 40 });
  expect(onEnd).toHaveBeenCalledWith({ x: 220, y: 40 });
  outside.remove();
});

test("two quick taps on a message are a double tap; slow ones or a button are not", () => {
  vi.useFakeTimers();
  const onDouble = vi.fn();
  const { getByTestId, getByRole } = render(
    <Host onReply={vi.fn()} onHold={vi.fn()} onDoubleTap={onDouble} />,
  );
  const text = getByTestId("text");
  const tap = (el: Element) => {
    press(el, 100);
    fireEvent.pointerUp(el);
  };
  tap(text);
  act(() => vi.advanceTimersByTime(200));
  tap(text);
  expect(onDouble).toHaveBeenCalledTimes(1);
  expect(onDouble).toHaveBeenCalledWith(7);
  // The pair is used up: a third tap starts a new one.
  act(() => vi.advanceTimersByTime(100));
  tap(text);
  expect(onDouble).toHaveBeenCalledTimes(1);
  act(() => vi.advanceTimersByTime(400));
  tap(text);
  expect(onDouble).toHaveBeenCalledTimes(1);
  tap(getByRole("button"));
  tap(getByRole("button"));
  expect(onDouble).toHaveBeenCalledTimes(1);
});
