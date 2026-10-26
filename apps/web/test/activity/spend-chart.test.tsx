import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { SpendDay } from "../../src/components/activity/activity-math";
import { SpendChart } from "../../src/components/activity/spend-chart";

vi.mock("../../src/api/client", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  const empty = async () => [];
  const client = {
    config: { bots: { list: empty }, groups: { list: empty } },
    conversations: { list: empty },
  };
  return { client, orpc: createTanstackQueryUtils(client as never) };
});

const week = (spend: number): SpendDay[] =>
  Array.from({ length: 7 }, (_, i) => ({
    day: `2026-10-${String(20 + i).padStart(2, "0")}`,
    byBot: (i === 6 && spend > 0 ? { dev: spend } : {}) as Record<string, number>,
    total: i === 6 ? spend : 0,
  }));

const renderChart = (days: SpendDay[]) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SpendChart days={days} />
    </QueryClientProvider>,
  );

test("no spend in the period is one quiet row, not an empty chart", () => {
  const { container } = renderChart(week(0));
  expect(screen.getByText(/No spend in the last 7 days/).textContent).toContain("$0.00");
  expect(container.querySelector(".bars")).toBeNull();
  expect(container.querySelector(".chart-total")).toBeNull();
});

test("with spend the chart shows the total and one bar per day", () => {
  const { container } = renderChart(week(1.25));
  expect(container.querySelector(".chart-total")?.textContent).toContain("$1.25");
  expect(container.querySelectorAll(".bar")).toHaveLength(7);
  expect(screen.queryByText(/No spend in the last/)).toBeNull();
});
