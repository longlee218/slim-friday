import type { ScheduleDto } from "@friday/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import type { Mock } from "vitest";
import { SchedulesRoute } from "../../src/components/schedules/schedules-route";
import { PanelsContext } from "../../src/components/shell/use-responsive-panels";
import { bot, group, seededClient } from "../shell/fixtures";

/** Shows the router's location so a test can see where the page navigated. */
const Where = () => {
  const l = useLocation();
  return <output data-testid="path">{l.pathname + l.search}</output>;
};
export const path = () => screen.getByTestId("path").textContent;

/**
 * Renders `/schedules` with `list` (the test's mocked `schedules.list`) serving `items`, and
 * Ray and the Crew group in the directory.
 */
export function renderList(list: Mock, items: ScheduleDto[]) {
  list.mockResolvedValue({ items });
  const qc = seededClient({
    bots: [bot("ray", "Ray")],
    groups: [group("crew", "Crew", ["ray"])],
  });
  const view = render(
    <QueryClientProvider client={qc}>
      <PanelsContext.Provider value={{ toggle: () => {} } as never}>
        <MemoryRouter initialEntries={["/schedules"]}>
          <Where />
          <SchedulesRoute />
        </MemoryRouter>
      </PanelsContext.Provider>
    </QueryClientProvider>,
  );
  return { ...view, qc };
}

/** The row of the schedule named `name`. */
export const row = async (name: string) =>
  (await screen.findByText(name)).closest(".sched-row") as HTMLElement;
/** Run now of a row is named after its schedule. */
export const runNowIn = (r: HTMLElement) =>
  within(r).getByRole("button", { name: /^Run .+ now$/ }) as HTMLButtonElement;
