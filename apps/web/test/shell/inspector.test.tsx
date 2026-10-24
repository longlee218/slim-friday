import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, test, vi } from "vitest";
import { Inspector } from "../../src/components/shell/inspector";
import { bot, conv, group, seededClient, status } from "./fixtures";

const stop = vi.hoisted(() => vi.fn());
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
      { ...bot("dev", "Dev"), title: "Developer", model: "sonnet", effort: "high" },
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
