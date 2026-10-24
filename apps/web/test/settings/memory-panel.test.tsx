import type { MemoryNoteDto } from "@friday/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { orpc } from "../../src/api/client";
import { MemoryPanel } from "../../src/components/settings/memory-panel";
import { bot, seededClient } from "../shell/fixtures";

const m = vi.hoisted(() => ({
  save: vi.fn().mockResolvedValue({ ok: true }),
  edit: vi.fn().mockResolvedValue({ ok: true }),
  delete: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
vi.mock("../../src/api/client", async (orig) => ({
  ...(await orig<typeof import("../../src/api/client")>()),
  client: { memory: m },
}));

const notes: MemoryNoteDto[] = [
  { id: "n1", kind: "fact", text: "Repo uses Bun.", day: "2026-10-20" },
  { id: "n2", kind: "preference", text: "Short answers.", day: "2026-10-21" },
  { id: "n3", kind: "lesson", text: "Run lint first." },
];

function setup() {
  const qc = seededClient({ bots: [bot("dev", "Dev")] });
  const owner = "bot:dev";
  qc.setQueryData(orpc.memory.list.queryKey({ input: { owner } }), {
    notes,
    promptChars: 4200,
    capChars: 12000,
  });
  qc.setQueryData(orpc.memory.journal.queryKey({ input: { owner } }), [
    { day: "2026-10-22", items: ["Fixed the build"] },
  ]);
  render(
    <QueryClientProvider client={qc}>
      <MemoryPanel owner={owner} />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());

test("filter and search narrow the rows; an empty result says so", async () => {
  setup();
  expect(screen.getAllByText(/Repo uses Bun|Short answers|Run lint first/)).toHaveLength(3);
  await userEvent.click(screen.getByRole("button", { name: "Lessons" }));
  expect(screen.queryByText("Repo uses Bun.")).toBeNull();
  expect(screen.getByText("Run lint first.")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "All" }));
  await userEvent.type(screen.getByPlaceholderText("Search memory"), "zzz");
  expect(screen.getByText("No notes match.")).toBeTruthy();
});

test("shows the meter, the journal and the files' place", () => {
  setup();
  expect(screen.getByText(/In Dev's prompt/).textContent).toContain("4.2k of 12k characters");
  expect(screen.getByText("Fixed the build")).toBeTruthy();
  expect(screen.getByText("~/.friday/memory/bots/dev/")).toBeTruthy();
  expect(screen.queryByText(/saved by/)).toBeNull();
});

test("add calls memory.save with the chosen kind", async () => {
  setup();
  await userEvent.selectOptions(screen.getByLabelText("Kind"), "decision");
  await userEvent.type(screen.getByPlaceholderText(/Add a note/), "Use Biome.");
  await userEvent.click(screen.getByRole("button", { name: "Add" }));
  await waitFor(() =>
    expect(m.save).toHaveBeenCalledWith({ owner: "bot:dev", kind: "decision", text: "Use Biome." }),
  );
});

test("edit saves the new text; delete calls memory.delete", async () => {
  setup();
  await userEvent.click(screen.getAllByRole("button", { name: "Edit note" })[0] as HTMLElement);
  const input = screen.getByDisplayValue("Repo uses Bun.");
  await userEvent.clear(input);
  await userEvent.type(input, "Repo uses Bun 1.3.{Enter}");
  await waitFor(() =>
    expect(m.edit).toHaveBeenCalledWith({ owner: "bot:dev", id: "n1", text: "Repo uses Bun 1.3." }),
  );
  await userEvent.click(screen.getAllByRole("button", { name: "Delete note" })[1] as HTMLElement);
  await waitFor(() => expect(m.delete).toHaveBeenCalledWith({ owner: "bot:dev", id: "n2" }));
});
