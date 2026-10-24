import type { FridayEvent } from "@friday/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, expect, test, vi } from "vitest";

// The real hook with a counting subscribe seam that never ends, so mounts are observable.
const subscribe = vi.hoisted(() => vi.fn());
const seen = vi.hoisted(() => ({ notify: undefined as undefined | ((n: unknown) => void) }));
const toasts = vi.hoisted(() => ({ custom: vi.fn(), dismiss: vi.fn() }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), toasts), Toaster: () => null }));
vi.mock("../../src/events/use-event-stream", async (orig) => {
  const real = await orig<typeof import("../../src/events/use-event-stream")>();
  return {
    ...real,
    useEventStream: (o: Parameters<typeof real.useEventStream>[0]) => {
      seen.notify = o.notify as never;
      return real.useEventStream({ ...o, subscribe: subscribe as never });
    },
  };
});

import { protectedChildren } from "../../src/app/protected-routes";
import { ResponsiveRoot } from "../../src/app/responsive-root";
import { navHistory } from "../../src/components/shell/nav-history";
import { messagesKey } from "../../src/events/apply-messages";
import { devConv, setup, stubMatchMedia } from "../chat/chat-view-fixtures";

async function* hang(signal?: AbortSignal): AsyncGenerator<FridayEvent> {
  await new Promise((_, reject) =>
    signal?.addEventListener("abort", () => reject(new Error("aborted"))),
  );
}

const resize = (width: number) =>
  act(() => {
    window.innerWidth = width;
    window.dispatchEvent(new Event("resize"));
  });

function renderRoot(path: string) {
  const qc = setup([[]]);
  qc.setQueryData(messagesKey("bot:dev"), { pages: [[]], pageParams: [undefined] });
  const router = createMemoryRouter(
    [{ element: <ResponsiveRoot />, children: protectedChildren }],
    {
      initialEntries: [path],
    },
  );
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

beforeEach(() => {
  stubMatchMedia();
  window.innerWidth = 1200;
  navHistory.reset("/c/bot:dev");
  subscribe.mockReset();
  toasts.custom.mockReset();
  subscribe.mockImplementation(async (_i: unknown, o?: { signal?: AbortSignal }) =>
    hang(o?.signal),
  );
});

test("crossing 1200 to 390 keeps the chat and the phone nav shows Dev", () => {
  const router = renderRoot("/c/bot:dev");
  expect(document.querySelector(".mac")).toBeTruthy();
  resize(390);
  expect(router.state.location.pathname).toBe("/c/bot:dev");
  const nav = document.querySelector(".chatnav") as HTMLElement;
  expect(nav.textContent).toContain("Dev");
  expect(document.querySelector(".mac")).toBeNull();
  // The stack is seeded under the chat, so Back leads to the list.
  expect(nav.textContent).toContain("Chats");
});

test("the composer draft survives the crossing", () => {
  renderRoot("/c/bot:dev");
  fireEvent.change(screen.getByPlaceholderText(/Message/), { target: { value: "half a thought" } });
  resize(390);
  expect((screen.getByPlaceholderText(/Message/) as HTMLTextAreaElement).value).toBe(
    "half a thought",
  );
  resize(1200);
  expect((screen.getByPlaceholderText(/Message/) as HTMLTextAreaElement).value).toBe(
    "half a thought",
  );
});

test("the event stream subscribes once across width crossings", async () => {
  renderRoot("/c/bot:dev");
  await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));
  resize(390);
  resize(1200);
  resize(500);
  await act(async () => {});
  expect(subscribe).toHaveBeenCalledTimes(1);
});

test("on the phone / is the Chats list and on desktop it opens the last chat", async () => {
  window.innerWidth = 390;
  const router = renderRoot("/");
  expect(screen.getAllByText("Chats").length).toBeGreaterThan(0);
  resize(1200);
  await waitFor(() => expect(router.state.location.pathname).toBe("/c/bot:dev"));
  expect(devConv.id).toBe("bot:dev");
});

/** A screen that fails while rendering. */
function Boom(): never {
  throw new Error("boom");
}

test("a render bug in a desktop screen says Something went wrong, not Can't reach Friday", async () => {
  const qc = setup([[]]);
  const routes = protectedChildren.map((r) => ({ ...r, element: <Boom /> }));
  const router = createMemoryRouter([{ element: <ResponsiveRoot />, children: routes }], {
    initialEntries: ["/tickets"],
  });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  expect(await screen.findByText("Something went wrong.")).toBeTruthy();
  expect(screen.queryByText("Can't reach Friday.")).toBeNull();
});

const note = { conversationId: "bot:pia", botId: "pia", title: "Pia", text: "hi" };

test("desktop toasts a notification; the phone does not", () => {
  renderRoot("/c/bot:dev");
  seen.notify?.(note);
  expect(toasts.custom).toHaveBeenCalledTimes(1);
  toasts.custom.mockReset();
  resize(390);
  seen.notify?.(note);
  expect(toasts.custom).not.toHaveBeenCalled();
});

test("exactly one .sidebar on desktop", () => {
  renderRoot("/c/bot:dev");
  expect(document.querySelectorAll(".sidebar")).toHaveLength(1);
});

test("an unknown path shows Nothing here with a link to Chats", () => {
  renderRoot("/foo");
  expect(screen.getByText("Nothing here.")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Go to Chats" }).getAttribute("href")).toBe("/");
});

test("the phone follows navigation into the last chat memory", () => {
  window.innerWidth = 390;
  renderRoot("/c/bot:pia");
  expect(navHistory.lastChat).toBe("/c/bot:pia");
});

test("⌘K opens the palette and Esc closes it without closing a floating panel", async () => {
  window.innerWidth = 800;
  renderRoot("/c/bot:dev");
  // Sidebar is closed below 900 px; ⌘0 floats it open.
  fireEvent.keyDown(window, { code: "Digit0", metaKey: true });
  expect(document.querySelector(".mac")?.classList.contains("nosb")).toBe(false);
  fireEvent.keyDown(window, { code: "KeyK", metaKey: true });
  const field = await screen.findByPlaceholderText("Search bots, groups, actions");
  fireEvent.keyDown(field, { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByPlaceholderText("Search bots, groups, actions")).toBeNull(),
  );
  expect(document.querySelector(".mac")?.classList.contains("nosb")).toBe(false);
});
