import { ORPCError } from "@orpc/client";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { InlineName } from "../../src/components/settings/inline-name";

const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

async function edit(onSave = vi.fn().mockResolvedValue(undefined)) {
  render(<InlineName value="Dev" onSave={onSave} />);
  await userEvent.click(screen.getByRole("button", { name: "Rename" }));
  return { onSave, input: screen.getByLabelText("Name") as HTMLInputElement };
}

test("Esc restores the name and saves nothing", async () => {
  const { onSave, input } = await edit();
  await userEvent.type(input, "x{Escape}");
  expect(onSave).not.toHaveBeenCalled();
  expect(screen.getByRole("heading", { name: "Dev" })).toBeTruthy();
});

test("Enter calls onSave once with the trimmed name and toasts the mention", async () => {
  const { onSave, input } = await edit();
  await userEvent.clear(input);
  await userEvent.type(input, " Devon {Enter}");
  expect(onSave).toHaveBeenCalledTimes(1);
  expect(onSave).toHaveBeenCalledWith("Devon");
  expect(toast).toHaveBeenCalledWith("Mentions use @Devon now");
});

test("an empty name shows the help text and does not save", async () => {
  const { onSave, input } = await edit();
  await userEvent.clear(input);
  await userEvent.type(input, "{Enter}");
  expect(onSave).not.toHaveBeenCalled();
  expect(screen.getByText("Use 1 to 32 characters.")).toBeTruthy();
  expect(input.className).toContain("shake");
});

test("a name over 32 characters is refused", async () => {
  const { onSave, input } = await edit();
  await userEvent.clear(input);
  await userEvent.type(input, `${"a".repeat(33)}{Enter}`);
  expect(onSave).not.toHaveBeenCalled();
  expect(screen.getByText("Use 1 to 32 characters.")).toBeTruthy();
});

test("a BAD_REQUEST shows its message and keeps the editor open", async () => {
  const err = new ORPCError("BAD_REQUEST", { message: "Name is taken" });
  const { input } = await edit(vi.fn().mockRejectedValue(err));
  await userEvent.type(input, "x{Enter}");
  expect(await screen.findByText("Name is taken")).toBeTruthy();
  expect(screen.getByLabelText("Name")).toBeTruthy();
});
