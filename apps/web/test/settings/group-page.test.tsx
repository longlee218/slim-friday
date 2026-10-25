import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { expect, test, vi } from "vitest";
import { orpc } from "../../src/api/client";
import { GroupPage } from "../../src/components/settings/group-page";
import { bot, group, seededClient } from "../shell/fixtures";

const save = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
vi.mock("../../src/components/settings/settings-page", () => ({
  SettingsPage: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useNavSlot: () => null,
}));
vi.mock("../../src/api/client", async (orig) => ({
  ...(await orig<typeof import("../../src/api/client")>()),
  client: { config: { groups: { save } } },
}));

test("changing instructions and saving calls groups.save in update mode", async () => {
  const crew = group("crew", "Crew", ["dev"]);
  const qc = seededClient({ bots: [bot("dev", "Dev")], groups: [crew] });
  qc.setQueryData(orpc.config.groups.get.queryKey({ input: { id: "crew" } }), crew);
  const router = createMemoryRouter([{ path: "/settings/group/:id", element: <GroupPage /> }], {
    initialEntries: ["/settings/group/crew"],
  });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await userEvent.type(await screen.findByLabelText("Instructions"), "Be kind.");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0]?.[0]).toMatchObject({
    id: "crew",
    mode: "update",
    group: { instructions: "Be kind." },
  });
});
