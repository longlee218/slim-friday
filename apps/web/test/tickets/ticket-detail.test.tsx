import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { TicketDetail } from "../../src/components/tickets/ticket-detail";
import { ticketListOptions } from "../../src/components/tickets/use-tickets";
import { seededClient } from "../shell/fixtures";
import { ticket } from "./fixtures";

const update = vi.hoisted(() => vi.fn());
vi.mock("../../src/api/client", async () => (await import("./mock-client")).mockApi({ update }));

test("choosing Blocked asks why, then saves status and reason together", async () => {
  const t = ticket(1);
  const qc = seededClient({});
  qc.setQueryData(ticketListOptions.queryKey, { pages: [{ items: [t] }], pageParams: [undefined] });
  update.mockResolvedValue({
    ...t,
    status: "blocked",
    blockedReason: "No vault access",
    updatedAt: 11,
  });
  render(
    <QueryClientProvider client={qc}>
      <TicketDetail ticket={t} />
    </QueryClientProvider>,
  );
  await userEvent.click(screen.getByRole("combobox", { name: "Status" }));
  await userEvent.click(await screen.findByRole("option", { name: "Blocked" }));
  expect(update).not.toHaveBeenCalled();
  const block = screen.getByRole("button", { name: "Block" }) as HTMLButtonElement;
  expect(block.disabled).toBe(true);
  await userEvent.type(screen.getByLabelText("Why blocked?"), "No vault access");
  await userEvent.click(block);
  await waitFor(() =>
    expect(update).toHaveBeenCalledWith({
      ref: "FRI-1",
      status: "blocked",
      blockedReason: "No vault access",
      expectedUpdatedAt: 10,
    }),
  );
});
