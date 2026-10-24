import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import type { Directory } from "../../src/api/directory";
import { CommandPalette } from "../../src/components/shell/command-palette";
import { paletteItems } from "../../src/components/shell/palette-items";
import { bot, group, seededClient, status } from "./fixtures";

const { stop, toast, navigate } = vi.hoisted(() => ({
  stop: vi.fn(),
  toast: Object.assign(vi.fn(), { custom: vi.fn(), dismiss: vi.fn() }),
  navigate: vi.fn(),
}));
vi.mock("sonner", () => ({ toast }));
vi.mock("../../src/api/client", async (orig) => ({
  ...(await orig<typeof import("../../src/api/client")>()),
  client: { control: { stop } },
}));
vi.mock("../../src/components/shell/use-app-navigate", () => ({
  useAppNavigate: () => navigate,
}));

const dev = { ...bot("dev", "Dev"), title: "Developer" };
const dir = {
  bots: new Map([["dev", dev]]),
  groups: new Map([["core", group("core", "Core team", ["dev", "pia"])]]),
  conversations: [],
  botName: (id: string) => id,
} as Directory;

function renderPalette(workingIds: string[] = []) {
  const qc = seededClient({
    bots: [dev, bot("pia", "Pia"), bot("ray", "Ray")],
    groups: [group("core", "Core team", ["dev", "pia"])],
    status: [
      status("dev", "Dev", workingIds.includes("dev")),
      status("pia", "Pia", workingIds.includes("pia")),
      status("ray", "Ray", workingIds.includes("ray")),
    ],
  });
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <CommandPalette open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
  return onOpenChange;
}

beforeEach(() => {
  stop.mockReset().mockResolvedValue({ stopped: 1 });
  toast.mockReset();
  navigate.mockReset();
});

const input = () => screen.getByPlaceholderText("Search bots, groups, actions");

test("filters and runs a bot item", async () => {
  const onOpenChange = renderPalette();
  const user = userEvent.setup();
  await user.type(input(), "de");
  expect(screen.getByText("Dev")).toBeTruthy();
  expect(screen.queryByText("Pia")).toBeNull();
  expect(screen.queryByText("Open tickets")).toBeNull();
  await user.keyboard("{Enter}");
  expect(navigate).toHaveBeenCalledWith("/c/bot:dev");
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test("shows No results", async () => {
  renderPalette();
  await userEvent.setup().type(input(), "zzz");
  expect(screen.getByText("No results")).toBeTruthy();
});

test("no Schedules item", () => {
  expect(paletteItems(dir).some((i) => /schedule/i.test(i.label))).toBe(false);
});

test("items carry the destinations and hints", () => {
  const items = paletteItems(dir);
  const by = (label: string) => items.find((i) => i.label === label);
  expect(by("Dev")?.sub).toBe("Developer");
  expect(by("Core team")?.sub).toBe("2 members");
  expect(by("Open tickets")?.shortcut).toBe("⌘2");
  expect(by("Open activity")?.shortcut).toBe("⌘3");
  const go = vi.fn();
  by("Core team")?.run({ navigate: go, stopAll: async () => {} });
  by("Skills & plugins")?.run({ navigate: go, stopAll: async () => {} });
  by("Open activity")?.run({ navigate: go, stopAll: async () => {} });
  expect(go.mock.calls).toEqual([["/c/group:core"], ["/settings/skills"], ["/ops"]]);
});

test("Stop every bot stops each working bot and toasts once", async () => {
  const onOpenChange = renderPalette(["dev", "ray"]);
  await userEvent.setup().click(screen.getByText("Stop every bot"));
  await waitFor(() => expect(toast).toHaveBeenCalledWith("Stopped every bot."));
  expect(stop.mock.calls).toEqual([[{ botId: "dev" }], [{ botId: "ray" }]]);
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test("Stop every bot with nobody working sends nothing", async () => {
  renderPalette([]);
  await userEvent.setup().click(screen.getByText("Stop every bot"));
  await waitFor(() => expect(toast).toHaveBeenCalledWith("No bot is working."));
  expect(stop).not.toHaveBeenCalled();
});

test("Stop every bot with one failure still stops the rest and says Try again", async () => {
  stop.mockReset().mockRejectedValueOnce(new Error("down")).mockResolvedValue({ stopped: 1 });
  renderPalette(["dev", "ray"]);
  await userEvent.setup().click(screen.getByText("Stop every bot"));
  await waitFor(() => expect(toast).toHaveBeenCalledWith("Could not stop. Try again."));
  expect(stop.mock.calls).toEqual([[{ botId: "dev" }], [{ botId: "ray" }]]);
  expect(toast).toHaveBeenCalledTimes(1);
});
