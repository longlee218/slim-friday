import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation, useNavigationType } from "react-router";
import { beforeEach, expect, test, vi } from "vitest";
import { useOpenNewSchedule } from "../../src/components/schedules/use-open-new-schedule";

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

/** A button that opens the new sheet, and where the router went and how. */
function Probe() {
  const open = useOpenNewSchedule();
  const l = useLocation();
  return (
    <>
      <button type="button" onClick={open}>
        New
      </button>
      <output>{`${useNavigationType()} ${l.pathname}${l.search}`}</output>
    </>
  );
}

const at = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Probe />
    </MemoryRouter>,
  );

test("on /schedules it replaces the entry (Back stays one step)", async () => {
  at("/schedules");
  await userEvent.click(screen.getByRole("button", { name: "New" }));
  expect(screen.getByRole("status").textContent).toBe("REPLACE /schedules?new=1");
});

test("elsewhere (the palette) it pushes /schedules?new=1", async () => {
  at("/c/bot:ray");
  await userEvent.click(screen.getByRole("button", { name: "New" }));
  expect(screen.getByRole("status").textContent).toBe("PUSH /schedules?new=1");
});
