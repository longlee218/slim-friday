import { act, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { beforeEach, expect, test, vi } from "vitest";
import { AppShell } from "../../src/components/shell/app-shell";
import { NavButtons } from "../../src/components/shell/nav-buttons";
import { navHistory } from "../../src/components/shell/nav-history";
import { Toolbar } from "../../src/components/shell/toolbar";
import { useShortcuts } from "../../src/components/shell/use-shortcuts";

/** Resize the jsdom window and fire the resize event. */
function resize(width: number) {
  act(() => {
    window.innerWidth = width;
    window.dispatchEvent(new Event("resize"));
  });
}

function Probe({ onPalette }: { onPalette?: () => void }) {
  useShortcuts({ onPalette });
  const { pathname } = useLocation();
  return (
    <>
      <Toolbar title="Dev" />
      <output data-testid="path">{pathname}</output>
      <input aria-label="field" />
    </>
  );
}

function renderShell(path: string, props: { onPalette?: () => void } = {}, inspector = true) {
  const router = createMemoryRouter(
    [
      {
        path: "*",
        element: (
          <AppShell
            sidebar={<nav>side</nav>}
            main={<Probe {...props} />}
            inspector={inspector ? <div>insp</div> : undefined}
          />
        ),
      },
    ],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

const mac = () => document.querySelector(".mac") as HTMLElement;
const key = (code: string, extra: KeyboardEventInit = {}) =>
  fireEvent.keyDown(window, { code, metaKey: true, ...extra });

beforeEach(() => {
  window.innerWidth = 1200;
  navHistory.reset("/c/bot:dev");
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }) as unknown as typeof window.matchMedia;
});

test("crossing 640 keeps the route", () => {
  renderShell("/c/bot:dev");
  resize(390);
  expect(screen.getByTestId("path").textContent).toBe("/c/bot:dev");
  expect(mac().dataset.mode).toBe("phone");
});

test("pointerdown on main closes a floating inspector", () => {
  window.innerWidth = 1000;
  renderShell("/c/bot:dev");
  expect(mac().className).not.toContain("insp");
  fireEvent.keyDown(window, { code: "Digit0", metaKey: true, altKey: true });
  expect(mac().className).toContain("insp");
  fireEvent.pointerDown(document.querySelector(".main") as HTMLElement);
  expect(mac().className).not.toContain("insp");
});

test("toolbar sidebar toggle closes and reopens the sidebar", () => {
  renderShell("/c/bot:dev");
  fireEvent.click(screen.getByLabelText("Toggle sidebar (⌘0)"));
  expect(mac().className).toContain("nosb");
  fireEvent.click(screen.getByLabelText("Toggle sidebar (⌘0)"));
  expect(mac().className).not.toContain("nosb");
});

test("toolbar gets the hairline once the content scrolls past 4px", () => {
  renderShell("/c/bot:dev");
  const content = document.createElement("div");
  content.className = "content";
  document.querySelector(".toolbar")?.parentElement?.append(content);
  content.scrollTop = 10;
  fireEvent.scroll(content);
  expect(document.querySelector(".toolbar")?.className).toContain("scrolled");
});

test("nav buttons are disabled at the ends and walk the history", () => {
  const router = renderShell("/c/bot:dev");
  const back = screen.getByLabelText("Back (⌘[)") as HTMLButtonElement;
  const fwd = screen.getByLabelText("Forward (⌘])") as HTMLButtonElement;
  expect([back.disabled, fwd.disabled]).toEqual([true, true]);
  act(() => navHistory.push("/tickets"));
  expect(back.disabled).toBe(false);
  fireEvent.click(back);
  expect(router.state.location.pathname).toBe("/c/bot:dev");
  expect(fwd.disabled).toBe(false);
});

test("NavButtons export renders standalone in a router", () => {
  const router = createMemoryRouter([{ path: "*", element: <NavButtons /> }]);
  render(<RouterProvider router={router} />);
  expect(screen.getByLabelText("Back (⌘[)")).toBeTruthy();
});

test("shortcuts: ⌘2 tickets, ⌘1 last chat, ⌘[ back, ⌘] forward", async () => {
  const router = renderShell("/c/bot:dev");
  await act(async () => key("Digit2"));
  expect(router.state.location.pathname).toBe("/tickets");
  await act(async () => key("BracketLeft"));
  expect(router.state.location.pathname).toBe("/c/bot:dev");
  await act(async () => key("BracketRight"));
  expect(router.state.location.pathname).toBe("/tickets");
  await act(async () => key("Digit1"));
  expect(router.state.location.pathname).toBe("/c/bot:dev");
});

test("⌘K calls onPalette; Ctrl works too", () => {
  const onPalette = vi.fn();
  renderShell("/c/bot:dev", { onPalette });
  key("KeyK");
  fireEvent.keyDown(window, { code: "KeyK", ctrlKey: true });
  expect(onPalette).toHaveBeenCalledTimes(2);
});

test("shortcuts are ignored while typing, except Esc", () => {
  window.innerWidth = 1000;
  const router = renderShell("/c/bot:dev");
  const field = screen.getByLabelText("field");
  fireEvent.keyDown(field, { code: "Digit2", metaKey: true });
  expect(router.state.location.pathname).toBe("/c/bot:dev");
  fireEvent.keyDown(window, { code: "Digit0", metaKey: true, altKey: true });
  expect(mac().className).toContain("insp");
  fireEvent.keyDown(field, { key: "Escape" });
  expect(mac().className).not.toContain("insp");
});

test("shortcuts do nothing in phone mode", () => {
  window.innerWidth = 390;
  const onPalette = vi.fn();
  renderShell("/c/bot:dev", { onPalette });
  key("KeyK");
  expect(onPalette).not.toHaveBeenCalled();
});

test("router.navigate(-1) and plain navigation keep canBack / canForward right", async () => {
  const router = renderShell("/c/bot:dev");
  await act(async () => {
    await router.navigate("/tickets");
  });
  expect([navHistory.canBack, navHistory.canForward]).toEqual([true, false]);
  await act(async () => {
    await router.navigate(-1);
  });
  expect(router.state.location.pathname).toBe("/c/bot:dev");
  expect([navHistory.canBack, navHistory.canForward]).toEqual([false, true]);
});

test("⌘K works while typing; ⌥⌘1 and ⇧⌘1 do not navigate", async () => {
  const onPalette = vi.fn();
  const router = renderShell("/c/bot:dev", { onPalette });
  fireEvent.keyDown(screen.getByLabelText("field"), { code: "KeyK", metaKey: true });
  expect(onPalette).toHaveBeenCalledTimes(1);
  await act(async () => key("Digit2", { altKey: true }));
  await act(async () => key("Digit2", { shiftKey: true }));
  expect(router.state.location.pathname).toBe("/c/bot:dev");
});
