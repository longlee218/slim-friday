import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, test, vi } from "vitest";
import { orpc } from "../../src/api/client";
import { Inspector } from "../../src/components/shell/inspector";
import { ticket } from "../tickets/fixtures";
import { bot, conv, group, seededClient, status } from "./fixtures";

const { stop, navigate } = vi.hoisted(() => ({ stop: vi.fn(), navigate: vi.fn() }));
vi.mock("../../src/components/shell/use-app-navigate", () => ({ useAppNavigate: () => navigate }));
vi.mock("../../src/api/client", async (orig) => ({
  ...(await orig<typeof import("../../src/api/client")>()),
  client: { control: { stop } },
}));

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

function renderInspector(id: string) {
  const qc = seededClient({
    bots: [
      {
        ...bot("dev", "Dev"),
        title: "Developer",
        model: "sonnet",
        effort: "high",
        workspaces: ["~/code/api"],
      },
      bot("pia", "Pia"),
    ],
    groups: [group("crew", "Crew", ["pia", "dev"])],
    conversations: [conv("bot:dev", 0), conv("group:crew", 0)],
    status: [
      {
        ...status("dev", "Dev", true, "Running tests", 0.82),
        tasks: [{ id: "t", description: "bun test" }],
      },
      status("pia", "Pia", false),
    ],
  });
  const owner = "bot:dev" as const;
  qc.setQueryData(orpc.memory.list.queryKey({ input: { owner } }), {
    notes: [
      { id: "a", kind: "fact", text: "x" },
      { id: "b", kind: "lesson", text: "y" },
    ],
    promptChars: 3000,
    capChars: 12000,
  });
  qc.setQueryData(orpc.memory.rules.get.queryKey({ input: { owner } }), [
    { text: "one", on: true },
    { text: "two", on: false },
  ]);
  qc.setQueryData(orpc.tickets.list.queryKey({ input: { assignee: "dev" } }), {
    items: [
      ticket(7, { title: "Fix login", status: "doing", assigneeBotId: "dev" }),
      ticket(8, { title: "Old work", status: "done", assigneeBotId: "dev" }),
    ],
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Inspector conversationId={id} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

test("bot inspector: hero, what it does now, about", () => {
  renderInspector("bot:dev");
  expect(screen.getByRole("heading", { name: "Dev" })).toBeTruthy();
  expect(screen.getByText("Developer · sonnet")).toBeTruthy();
  expect(screen.getByText("Running tests")).toBeTruthy();
  expect(screen.getByText("bun test")).toBeTruthy();
  expect(screen.getByText("high")).toBeTruthy();
  expect(screen.getByText("$0.82")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Stop" }) as HTMLButtonElement).disabled).toBe(false);
});

test("group inspector lists members and marks the entry bot", () => {
  renderInspector("group:crew");
  expect(screen.getByRole("heading", { name: "Crew" })).toBeTruthy();
  expect(screen.getAllByText("entry")).toHaveLength(1);
  expect(screen.getByText("Idle")).toBeTruthy();
  expect(screen.getByText("Running tests")).toBeTruthy();
});

test("bot inspector: memory counts, workspace and open tickets", async () => {
  renderInspector("bot:dev");
  expect(screen.getByText("Notes").nextSibling?.textContent).toBe("2");
  expect(screen.getByText("1 on")).toBeTruthy();
  expect(screen.getByText("~/code/api")).toBeTruthy();
  expect(screen.getByText("Fix login")).toBeTruthy();
  expect(screen.queryByText("Old work")).toBeNull();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Memory" }));
  await user.click(screen.getByRole("button", { name: "Rules" }));
  await user.click(screen.getByText("Fix login"));
  expect(navigate.mock.calls).toEqual([
    ["/settings/bot/dev/memory"],
    ["/settings/bot/dev/rules"],
    ["/tickets?t=FRI-7"],
  ]);
});
