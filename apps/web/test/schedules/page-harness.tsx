import type { ScheduleDto } from "@friday/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { SchedulePageRoute } from "../../src/components/schedules/schedule-page-route";
import { PanelsContext } from "../../src/components/shell/use-responsive-panels";
import { bot, group, seededClient } from "../shell/fixtures";
import { schedule } from "./fixtures";

/** Shows the router's location so a test can see where the page navigated. */
const Where = () => {
  const l = useLocation();
  return <output data-testid="path">{l.pathname + l.search}</output>;
};
export const path = () => screen.getByTestId("path").textContent;

/** Renders `/schedules/a` with Ray (in Crew) in the directory; the test's `get` mock serves it. */
export function renderPage() {
  const qc = seededClient({ bots: [bot("ray", "Ray")], groups: [group("crew", "Crew", ["ray"])] });
  return render(
    <QueryClientProvider client={qc}>
      <PanelsContext.Provider value={{ toggle: () => {} } as never}>
        <MemoryRouter initialEntries={["/schedules/a"]}>
          <Where />
          <Routes>
            <Route path="/schedules/:id" element={<SchedulePageRoute />} />
            <Route path="*" element={null} />
          </Routes>
        </MemoryRouter>
      </PanelsContext.Provider>
    </QueryClientProvider>,
  );
}

/** Schedule `a`, "Morning news", daily 07:30 in Asia/Ho_Chi_Minh, posting to Ray's chat. */
export const news = (over: Partial<ScheduleDto> = {}) =>
  schedule("a", { name: "Morning news", timeZone: "Asia/Ho_Chi_Minh", ...over });
export const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
export const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

/** A stand-in for `matchMedia` (desktop layout). */
export const desktopMedia = () => ({
  matches: false,
  addEventListener: () => {},
  removeEventListener: () => {},
});
