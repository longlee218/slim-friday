import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { NewTicketSheet } from "../../src/components/tickets/new-ticket-sheet";
import { bot, seededClient } from "../shell/fixtures";
import { ticket } from "./fixtures";

const create = vi.hoisted(() => vi.fn());
vi.mock("../../src/api/client", async () => (await import("./mock-client")).mockApi({ create }));

function setup() {
  const onOpenChange = vi.fn();
  const onCreated = vi.fn();
  const qc = seededClient({ bots: [bot("dev", "Dev")] });
  render(
    <QueryClientProvider client={qc}>
      <NewTicketSheet open onOpenChange={onOpenChange} onCreated={onCreated} />
    </QueryClientProvider>,
  );
  return { onOpenChange, onCreated };
}

const createButton = () =>
  screen.getByRole("button", { name: "Create ticket" }) as HTMLButtonElement;

test("Create is disabled while the title is empty or blank", async () => {
  setup();
  expect(createButton().disabled).toBe(true);
  await userEvent.type(screen.getByLabelText("Title"), "   ");
  expect(createButton().disabled).toBe(true);
  await userEvent.type(screen.getByLabelText("Title"), "x");
  expect(createButton().disabled).toBe(false);
});

test("Create sends the trimmed title, then closes and reports the ticket", async () => {
  create.mockResolvedValue(ticket(7, { title: "Fix it" }));
  const { onOpenChange, onCreated } = setup();
  await userEvent.type(screen.getByLabelText("Title"), "  Fix it  ");
  await userEvent.click(createButton());
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ title: "Fix it" }));
  expect(create.mock.calls[0]?.[0].description).toBeUndefined();
  expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ ref: "FRI-7" }));
});

test("phone: the bar holds Cancel and Create; no bottom buttons", async () => {
  window.innerWidth = 390;
  try {
    const { onOpenChange } = setup();
    const bar = document.querySelector(".bsheet .bs-bar") as HTMLElement;
    expect(bar.contains(createButton())).toBe(true);
    expect(document.querySelector(".bsheet .acts")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  } finally {
    window.innerWidth = 1024;
  }
});
