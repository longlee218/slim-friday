import type { MemoryNoteDto } from "@friday/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { beforeEach, expect, test, vi } from "vitest";
import { orpc } from "../../src/api/client";
import { MemoryPanel } from "../../src/components/settings/memory-panel";
import { bot, seededClient } from "../shell/fixtures";

const m = vi.hoisted(() => ({
  save: vi.fn().mockResolvedValue({ ok: true }),
  edit: vi.fn().mockResolvedValue({ ok: true }),
  delete: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock("../../src/api/client", async (orig) => ({
  ...(await orig<typeof import("../../src/api/client")>()),
  client: { memory: m },
}));

const notes: MemoryNoteDto[] = [
  { id: "n1", kind: "fact", text: "Repo uses Bun.", day: "2026-10-20" },
  { id: "n2", kind: "preference", text: "Short answers.", day: "2026-10-21" },
  { id: "n3", kind: "lesson", text: "Run lint first." },
];

let qcRef: QueryClient;
function setup() {
  const qc = seededClient({ bots: [bot("dev", "Dev")] });
  qcRef = qc;
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

test("in a kind's tab the add row has no kind picker and saves that kind", async () => {
  setup();
  await userEvent.click(screen.getByRole("button", { name: "Decisions" }));
  expect(screen.queryByLabelText("Kind")).toBeNull();
  await userEvent.type(screen.getByPlaceholderText(/Add a note/), "Ship on Friday.");
  await userEvent.click(screen.getByRole("button", { name: "Add" }));
  await waitFor(() =>
    expect(m.save).toHaveBeenCalledWith({
      owner: "bot:dev",
      kind: "decision",
      text: "Ship on Friday.",
    }),
  );
});

test("a failed edit keeps the draft and reloads the list on a conflict", async () => {
  m.edit.mockRejectedValueOnce(Object.assign(new Error("changed"), { code: "CONFLICT" }));
  setup();
  const spy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
  await userEvent.click(screen.getAllByRole("button", { name: "Edit note" })[0] as HTMLElement);
  const input = screen.getByDisplayValue("Repo uses Bun.");
  await userEvent.clear(input);
  await userEvent.type(input, "My long text{Enter}");
  await waitFor(() => expect(spy).toHaveBeenCalled());
  expect(screen.getByDisplayValue("My long text")).toBeTruthy();
});

test("a conflict whose row is gone after the reload still shows the owner's text, and it can be added in its kind", async () => {
  m.edit.mockRejectedValueOnce(Object.assign(new Error("changed"), { code: "CONFLICT" }));
  setup();
  vi.spyOn(QueryClient.prototype, "invalidateQueries").mockImplementation(async () => {
    // The refetched list no longer has n1.
    qcRef.setQueryData(orpc.memory.list.queryKey({ input: { owner: "bot:dev" } }), {
      notes: notes.slice(1),
      promptChars: 1,
      capChars: 12000,
    });
  });
  await userEvent.click(screen.getAllByRole("button", { name: "Edit note" })[0] as HTMLElement);
  const input = screen.getByDisplayValue("Repo uses Bun.");
  await userEvent.clear(input);
  await userEvent.type(input, "<b>My long text</b>{Enter}");
  expect(await screen.findByText("<b>My long text</b>")).toBeTruthy();
  // The edited note was a fact: the banner names it, and re-adding keeps it a fact (never a preference,
  // which group sessions see).
  expect(screen.getByText("This fact note changed. Your text:")).toBeTruthy();
  expect(screen.queryByText("Repo uses Bun.")).toBeNull();
  expect(toast.error).toHaveBeenCalledWith("changed");
  await userEvent.click(screen.getByRole("button", { name: "Add as new note" }));
  await waitFor(() =>
    expect(m.save).toHaveBeenCalledWith({
      owner: "bot:dev",
      kind: "fact",
      text: "<b>My long text</b>",
    }),
  );
  await waitFor(() => expect(screen.queryByText("This fact note changed. Your text:")).toBeNull());
});

test("a blur while the save is in flight keeps the draft when the save fails", async () => {
  let fail: (e: unknown) => void = () => {};
  m.edit.mockReturnValueOnce(new Promise((_, rej) => (fail = rej)));
  setup();
  await userEvent.click(screen.getAllByRole("button", { name: "Edit note" })[0] as HTMLElement);
  const input = screen.getByDisplayValue("Repo uses Bun.");
  await userEvent.clear(input);
  await userEvent.type(input, "Kept text{Enter}");
  await userEvent.click(document.body); // blur while pending
  expect(screen.getByDisplayValue("Kept text")).toBeTruthy();
  fail(Object.assign(new Error("nope"), { code: "BAD_REQUEST" }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith("nope"));
  expect(screen.getByDisplayValue("Kept text")).toBeTruthy();
});

/** An edit that conflicts and whose row is gone after the reload: the banner holds the owner's text. */
async function loseNoteRow() {
  m.edit.mockRejectedValueOnce(Object.assign(new Error("changed"), { code: "CONFLICT" }));
  setup();
  vi.spyOn(QueryClient.prototype, "invalidateQueries").mockImplementation(async () => {
    qcRef.setQueryData(orpc.memory.list.queryKey({ input: { owner: "bot:dev" } }), {
      notes: notes.slice(1),
      promptChars: 1,
      capChars: 12000,
    });
  });
  await userEvent.click(screen.getAllByRole("button", { name: "Edit note" })[0] as HTMLElement);
  const input = screen.getByDisplayValue("Repo uses Bun.");
  await userEvent.clear(input);
  await userEvent.type(input, "Held text{Enter}");
  await screen.findByText("Held text");
}

test("a double click on Add as new note saves the held text once", async () => {
  await loseNoteRow();
  const add = screen.getByRole("button", { name: "Add as new note" });
  await userEvent.dblClick(add);
  await waitFor(() => expect(screen.queryByText("Held text")).toBeNull());
  expect(m.save).toHaveBeenCalledTimes(1);
});

test("a failed add keeps the held text so the owner can retry", async () => {
  await loseNoteRow();
  m.save.mockRejectedValueOnce(new Error("no space"));
  await userEvent.click(screen.getByRole("button", { name: "Add as new note" }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith("no space"));
  expect(screen.getByText("Held text")).toBeTruthy();
});
