import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { expect, test, vi } from "vitest";
import { orpc } from "../../src/api/client";
import { BotPage } from "../../src/components/settings/bot-page";
import { bot, seededClient } from "../shell/fixtures";

vi.mock("../../src/components/settings/settings-page", () => ({
  SettingsPage: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useNavSlot: () => null,
}));

function mount(computer?: string) {
  const dev = { ...bot("dev", "Dev"), ...(computer && { computer }) };
  const qc = seededClient({ bots: [dev] });
  qc.setQueryData(orpc.config.bots.get.queryKey({ input: { id: "dev" } }), dev);
  const router = createMemoryRouter([{ path: "/settings/bot/:id/:tab?", element: <BotPage /> }], {
    initialEntries: ["/settings/bot/dev/profile"],
  });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

test("a bot without a computer has no Computer tab or action", async () => {
  mount();
  await screen.findByRole("tab", { name: "Rules" });
  expect(screen.queryByRole("tab", { name: "Computer" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Open computer" })).toBeNull();
});

test("a bot with a computer shows the Computer tab and action", async () => {
  mount("desk");
  expect(await screen.findByRole("tab", { name: "Computer" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open computer" })).toBeTruthy();
});
