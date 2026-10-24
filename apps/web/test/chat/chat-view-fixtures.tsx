import type { ConversationDto, MessageDto } from "@friday/contracts";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { vi } from "vitest";
import { ChatView } from "../../src/components/chat/chat-view";
import { AppShell } from "../../src/components/shell/app-shell";
import { messagesKey } from "../../src/events/apply-messages";
import { bot, conv, group, seededClient, status } from "../shell/fixtures";

export const devConv: ConversationDto = { ...conv("bot:dev", 3), botId: "dev", title: "Dev" };
export const crewConv: ConversationDto = {
  ...conv("group:crew", 0),
  groupId: "crew",
  title: "Crew",
};

/** jsdom has no matchMedia (the shell reads it). */
export function stubMatchMedia() {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

/** A client with Dev, Pia and a Crew group; `pages` seeds the Dev transcript. */
export function setup(pages: MessageDto[][]): QueryClient {
  const qc = seededClient({
    bots: [{ ...bot("dev", "Dev"), title: "Developer" }, bot("pia", "Pia")],
    groups: [group("crew", "Crew", ["pia", "dev"])],
    conversations: [devConv, crewConv],
    status: [status("dev", "Dev", false), status("pia", "Pia", true, "Writing")],
  });
  qc.setQueryData(messagesKey("bot:dev"), { pages, pageParams: pages.map(() => undefined) });
  qc.setQueryData(messagesKey("group:crew"), { pages: [[]], pageParams: [undefined] });
  return qc;
}

/** ChatView inside AppShell at `path`; returns the router so a test can navigate. */
export function renderChat(qc: QueryClient, path = "/c/bot:dev") {
  const router = createMemoryRouter(
    [
      {
        path: "/c/:conversationId",
        element: <AppShell sidebar={<nav>side</nav>} main={<ChatView />} />,
      },
    ],
    { initialEntries: [path] },
  );
  const view = render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, router };
}
