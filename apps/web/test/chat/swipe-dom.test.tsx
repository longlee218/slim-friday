import { act, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { useSwipeToReply } from "../../src/components/chat/swipe-to-reply";

afterEach(() => vi.useRealTimers());

/** A scroller with one bot message (id 7) wired to the hook. */
function Host({ onReply, onHold }: { onReply(id: number): void; onHold(id: number): void }) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  useSwipeToReply(el, { onReply, onHold });
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

test("holding 450 ms opens the sheet; vertical movement cancels", () => {
  vi.useFakeTimers();
  const onHold = vi.fn();
  const { getByTestId } = render(<Host onReply={vi.fn()} onHold={onHold} />);
  const text = getByTestId("text");
  press(text, 100);
  act(() => vi.advanceTimersByTime(450));
  expect(onHold).toHaveBeenCalledWith(7);
  press(text, 100);
  fireEvent.pointerMove(text, { clientX: 101, clientY: 130 });
  act(() => vi.advanceTimersByTime(600));
  expect(onHold).toHaveBeenCalledTimes(1);
});
