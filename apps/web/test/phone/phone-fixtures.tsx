import type { MessageDto } from "@friday/contracts";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { vi } from "vitest";
import { orpc } from "../../src/api/client";
import { protectedChildren } from "../../src/app/protected-routes";
import { PhoneShell } from "../../src/components/phone/phone-shell";
import { approval, bot, conv, group, seededClient, status } from "../shell/fixtures";

export const msg = (conversationId: string, text: string, at = Date.now()): MessageDto => ({
  id: 1,
  conversationId,
  author: { kind: "bot", botId: "dev" },
  kind: "text",
  text,
  at,
  files: [],
});

/** jsdom has no matchMedia. */
export function stubMatchMedia() {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

/** Dev (working, 1 approval), Pia, a Crew group with a question; Pia's last message is a relay. */
export function phoneClient(): QueryClient {
  const qc = seededClient({
    bots: [bot("dev", "Dev"), bot("pia", "Pia")],
    groups: [group("crew", "Crew", ["pia", "dev"])],
    conversations: [
      {
        ...conv("bot:dev", 2),
        botId: "dev",
        title: "Dev",
        lastMessage: msg("bot:dev", "Pushed it"),
      },
      {
        ...conv("bot:pia", 0),
        botId: "pia",
        title: "Pia",
        lastMessage: {
          ...msg("bot:pia", "draft is ready"),
          kind: "relay",
          relay: { fromBotId: "pia", toBotId: "dev", intent: "request" },
        },
      },
      { ...conv("group:crew", 0), groupId: "crew", title: "Crew" },
    ],
    status: [status("dev", "Dev", true, "Running tests", 1.5), status("pia", "Pia", false)],
    approvals: [approval("a1", "dev")],
  });
  qc.setQueryData(orpc.questions.pending.queryKey(), [
    {
      cardId: "q1",
      conversationId: "group:crew",
      botId: "pia",
      botName: "Pia",
      question: "Which branch?",
      kind: "single",
      options: [],
      allowText: false,
    },
  ]);
  return qc;
}

/** PhoneShell over the protected routes at `path`; returns the router. */
export function renderPhone(qc: QueryClient, path: string) {
  const router = createMemoryRouter(
    [{ path: "*", element: <PhoneShell routes={protectedChildren} /> }],
    { initialEntries: [path] },
  );
  const view = render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, router };
}
