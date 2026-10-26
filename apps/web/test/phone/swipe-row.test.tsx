import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { SwipeRow } from "../../src/components/phone/swipe-row";

function renderRow(open = false, disabled = false) {
  const onOpenChange = vi.fn();
  const onDelete = vi.fn();
  const onRowClick = vi.fn((e: { preventDefault(): void }) => e.preventDefault());
  render(
    <SwipeRow open={open} onOpenChange={onOpenChange} onDelete={onDelete} disabled={disabled}>
      <a href="/c/bot:dev" onClick={onRowClick}>
        Dev row
      </a>
    </SwipeRow>,
  );
  return { onOpenChange, onDelete, onRowClick, row: screen.getByText("Dev row") };
}

const drag = (el: Element, dx: number, dy = 0) => {
  fireEvent.pointerDown(el, { clientX: 200, clientY: 100, pointerId: 1 });
  fireEvent.pointerMove(el, { clientX: 200 + dx, clientY: 100 + dy, pointerId: 1 });
  fireEvent.pointerUp(el, { clientX: 200 + dx, clientY: 100 + dy, pointerId: 1 });
};

test("a left drag past half the button opens the row; a short one does not", () => {
  const { onOpenChange, row } = renderRow();
  drag(row, -60);
  expect(onOpenChange).toHaveBeenLastCalledWith(true);
  drag(row, -20);
  expect(onOpenChange).toHaveBeenLastCalledWith(false);
});

test("a vertical drag (a scroll) never opens the row", () => {
  const { onOpenChange, row } = renderRow();
  drag(row, -5, 40);
  expect(onOpenChange).not.toHaveBeenCalledWith(true);
});

test("a tap on an open row closes it without opening the chat", () => {
  const { onOpenChange, onRowClick, row } = renderRow(true);
  fireEvent.click(row);
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(onRowClick).not.toHaveBeenCalled();
});

test("a tap on a closed row opens the chat", () => {
  const { onRowClick, row } = renderRow();
  fireEvent.click(row);
  expect(onRowClick).toHaveBeenCalled();
});

test("Delete on an open row asks to delete", () => {
  const { onDelete } = renderRow(true);
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(onDelete).toHaveBeenCalled();
});

test("a disabled row has no Delete and never slides", () => {
  const { onOpenChange, row } = renderRow(false, true);
  drag(row, -100);
  expect(onOpenChange).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
});
