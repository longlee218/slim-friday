import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test, vi } from "vitest";
import { orpc } from "../../src/api/client";
import { BotNewPage } from "../../src/components/settings/bot-page";
import { seededClient } from "../shell/fixtures";

const m = vi.hoisted(() => ({
  save: vi.fn().mockResolvedValue({}),
  setAvatar: vi.fn().mockResolvedValue({}),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock("../../src/api/client", async (orig) => ({
  ...(await orig<typeof import("../../src/api/client")>()),
  client: { config: { bots: { save: m.save, setAvatar: m.setAvatar } } },
}));

afterEach(() => {
  window.innerWidth = 1024;
});

const renderPage = () => {
  const qc = seededClient({});
  qc.setQueryData(orpc.config.avatars.list.queryKey(), [{ name: "dev", url: "/avatars/dev.webp" }]);
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <BotNewPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

test("desktop: the page head names the new bot", () => {
  renderPage();
  expect(screen.getByRole("heading", { name: "New bot" })).toBeTruthy();
});

test("phone: the nav bar names the page, so there is no second heading", () => {
  window.innerWidth = 390;
  renderPage();
  expect(screen.queryByRole("heading", { name: "New bot" })).toBeNull();
  expect(screen.getByText("New bot", { selector: ".ios-nav .ttl" })).toBeTruthy();
});

test("an avatar picked before the bot exists is saved right after the bot", async () => {
  renderPage();
  await userEvent.type(screen.getByLabelText("Name"), "Ray");
  await userEvent.click(screen.getByRole("button", { name: "Change avatar" }));
  await userEvent.click(await screen.findByRole("button", { name: "dev" }));
  expect(m.setAvatar).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(m.setAvatar).toHaveBeenCalledWith({ id: "ray", preset: "dev" }));
  expect(m.save.mock.invocationCallOrder[0]).toBeLessThan(m.setAvatar.mock.invocationCallOrder[0]);
});

test("phone: the avatar can be picked on a new bot too", () => {
  window.innerWidth = 390;
  renderPage();
  expect(screen.getByRole("button", { name: "Change avatar" })).toBeTruthy();
});
