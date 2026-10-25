import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, test } from "vitest";
import { orpc } from "../../src/api/client";
import { ScratchpadSection } from "../../src/components/shell/bot-inspector-sections";
import { seededClient } from "./fixtures";

/** Render the section with `scopes` seeded for bot dev (undefined: not loaded yet). */
function renderSection(scopes?: unknown) {
  const qc = seededClient({});
  if (scopes)
    qc.setQueryData(
      orpc.config.bots.scratchpad.queryKey({ input: { id: "dev" } }),
      scopes as never,
    );
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ScratchpadSection botId="dev" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

test("lists open and parked items per scope", () => {
  renderSection([
    {
      scope: "direct",
      items: [{ id: "1", title: "Draft", status: "open", notes: "", updatedAt: 1 }],
    },
    {
      scope: { groupId: "crew", name: "Crew" },
      items: [{ id: "2", title: "Wait", status: "parked", notes: "", updatedAt: 1 }],
    },
  ]);
  expect(screen.getByText("Direct chat")).toBeTruthy();
  expect(screen.getByText("Crew")).toBeTruthy();
  expect(screen.getByText("Draft")).toBeTruthy();
  expect(screen.getByText("parked")).toBeTruthy();
});

test("shows an empty note when nothing is open", () => {
  renderSection([]);
  expect(screen.getByText("Nothing open")).toBeTruthy();
});
