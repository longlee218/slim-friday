import { MAX_OWNER_FILE_CHARS } from "@friday/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, test, vi } from "vitest";
import { orpc } from "../../src/api/client";
import { OwnerFileEditor } from "../../src/components/settings/owner-file-editor";
import { seededClient } from "../shell/fixtures";

const save = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("../../src/api/client", async (orig) => ({
  ...(await orig<typeof import("../../src/api/client")>()),
  client: { config: { owner: { save } } },
}));

function setup(text = "# Tone\n\nBe brief.") {
  const qc = seededClient({});
  qc.setQueryData(orpc.config.owner.get.queryKey({ input: { file: "USER" } }), {
    file: "USER",
    text,
  });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <OwnerFileEditor file="user" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());

test("shows the title, file name and hint", () => {
  setup();
  expect(screen.getByText("About you")).toBeTruthy();
  expect(screen.getByText("Every bot reads it before each turn.")).toBeTruthy();
  expect(screen.getByText("~/.friday/config/USER.md")).toBeTruthy();
});

test("over the limit the count is red and Save is disabled", async () => {
  setup("");
  const box = screen.getByRole("textbox");
  fireEvent.change(box, { target: { value: "a".repeat(MAX_OWNER_FILE_CHARS + 1) } });
  const count = screen.getByText("20,001 characters");
  expect(count.className).toContain("err");
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
});

test("save calls config.owner.save and says when the bot uses it", async () => {
  setup("old");
  await userEvent.clear(screen.getByRole("textbox"));
  await userEvent.type(screen.getByRole("textbox"), "new");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith({ file: "USER", text: "new" }));
  await waitFor(() => expect(toast).toHaveBeenCalledWith("The bot uses it from its next turn"));
});

test("Preview renders markdown as a heading", async () => {
  setup();
  await userEvent.click(screen.getByRole("button", { name: "Preview" }));
  expect(screen.getByRole("heading", { name: "Tone" })).toBeTruthy();
});
