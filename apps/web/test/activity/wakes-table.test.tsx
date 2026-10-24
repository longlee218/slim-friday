import type { WakeDto } from "@friday/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { WakesTable } from "../../src/components/activity/wakes-table";
import { bot, seededClient } from "../shell/fixtures";

const wake = (id: string, status: WakeDto["status"]): WakeDto => ({
  id,
  chainId: "c",
  conversationId: "bot:dev",
  targetBot: "dev",
  sender: { kind: "user" },
  intent: "request",
  hop: 0,
  status,
  attempts: 1,
  createdAt: 1_000,
  startedAt: 1_000,
  endedAt: 61_000,
});

test("Failed shows only blocked, interrupted and dropped wakes; All shows every row", async () => {
  const qc = seededClient({ bots: [bot("dev", "Dev")] });
  render(
    <QueryClientProvider client={qc}>
      <WakesTable
        now={100_000}
        wakes={[wake("w-done", "done"), wake("w-run", "running"), wake("w-bad", "blocked")]}
      />
    </QueryClientProvider>,
  );
  expect(screen.getAllByRole("row")).toHaveLength(4);
  await userEvent.click(screen.getByRole("button", { name: "Failed" }));
  expect(screen.getByText("w-bad")).toBeTruthy();
  expect(screen.queryByText("w-done")).toBeNull();
  expect(screen.queryByText("w-run")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Running" }));
  expect(screen.getByText("w-run")).toBeTruthy();
  expect(screen.queryByText("w-bad")).toBeNull();
});
