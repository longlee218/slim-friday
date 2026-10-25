import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { PhoneSheetForm, SheetBar } from "../../src/components/ui/sheet-bar";

test("SheetBar: Cancel on the left, the title, the action on the right", async () => {
  const onCancel = vi.fn();
  render(
    <SheetBar
      title="New schedule"
      onCancel={onCancel}
      action={<button type="button">Create</button>}
    />,
  );
  expect(screen.getByRole("heading", { name: "New schedule" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Create" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onCancel).toHaveBeenCalledOnce();
});

test("PhoneSheetForm: fields sit in the scrolling body and Enter submits once", async () => {
  const onSubmit = vi.fn();
  render(
    <PhoneSheetForm
      title="New ticket"
      onCancel={() => {}}
      onSubmit={onSubmit}
      action={<button type="submit">Create</button>}
    >
      <input aria-label="Title" />
    </PhoneSheetForm>,
  );
  const field = screen.getByRole("textbox", { name: "Title" });
  expect(field.closest(".bs-body")).not.toBeNull();
  expect(screen.getByRole("heading", { name: "New ticket" }).closest(".bs-body")).toBeNull();
  await userEvent.type(field, "x{Enter}");
  expect(onSubmit).toHaveBeenCalledOnce();
});
