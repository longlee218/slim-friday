import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { GroupForm, type GroupFormValue } from "../../src/components/settings/group-form";
import { bot, seededClient } from "../shell/fixtures";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

const crew: GroupFormValue = {
  id: "crew",
  name: "Crew",
  members: ["dev", "ops"],
  entryBot: "dev",
  workspaces: [],
  instructions: "Be kind.",
};

function setup(initial: GroupFormValue = crew) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const qc = seededClient({ bots: [bot("dev", "Dev"), bot("ops", "Ops")] });
  const ui = (v: GroupFormValue) => (
    <QueryClientProvider client={qc}>
      <GroupForm initial={v} mode="update" onSave={onSave} />
    </QueryClientProvider>
  );
  const view = render(ui(initial));
  return { onSave, rerender: (v: GroupFormValue) => view.rerender(ui(v)) };
}

const field = () => screen.getByLabelText("Instructions") as HTMLTextAreaElement;

test("a clean form shows new server data", () => {
  const { rerender } = setup();
  rerender({ ...crew, instructions: "Newer." });
  expect(field().value).toBe("Newer.");
});

test("a dirty form keeps edits, shows the notice, and Revert loads the new data", async () => {
  const { rerender } = setup();
  await userEvent.type(field(), "!");
  rerender({ ...crew, instructions: "Newer." });
  expect(field().value).toBe("Be kind.!");
  expect(
    screen.getByText(
      "This group changed elsewhere. Revert to load the latest, or save to overwrite it.",
    ),
  ).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Revert" }));
  expect(field().value).toBe("Newer.");
  expect(screen.queryByText(/changed elsewhere/)).toBeNull();
});

test("removing the entry bot moves it to a remaining member", async () => {
  setup();
  await userEvent.click(screen.getByRole("button", { name: /Remove Dev/ }));
  expect(screen.queryByText("The entry bot must be a member.")).toBeNull();
  expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", false);
});

test("removing the last member empties the entry bot", async () => {
  setup({ ...crew, members: ["dev"] });
  await userEvent.click(screen.getByRole("button", { name: /Remove Dev/ }));
  expect(screen.getByText("Add a member first.")).toBeTruthy();
});

test("changing instructions and saving sends the full value", async () => {
  const { onSave } = setup();
  await userEvent.type(field(), "!");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(onSave).toHaveBeenCalledWith({ ...crew, instructions: "Be kind.!" });
});

test("a new group gets its id from its name (no Id field)", async () => {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const qc = seededClient({ bots: [bot("dev", "Dev")] });
  render(
    <QueryClientProvider client={qc}>
      <GroupForm
        initial={{ ...crew, id: "", name: "", members: ["dev"] }}
        mode="create"
        onSave={onSave}
      />
    </QueryClientProvider>,
  );
  expect(screen.queryByLabelText("Id")).toBeNull();
  await userEvent.type(screen.getByLabelText("Name"), "Đội Dữ liệu");
  expect(screen.getByText("File id: doi-du-lieu")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ id: "doi-du-lieu" }));
});

test("no members yet: Entry bot asks for a member first; the first member added becomes it", async () => {
  const qc = seededClient({ bots: [bot("dev", "Dev"), bot("ops", "Ops")] });
  render(
    <QueryClientProvider client={qc}>
      <GroupForm
        initial={{ ...crew, id: "", name: "", members: [], entryBot: "" }}
        mode="create"
        onSave={vi.fn()}
      />
    </QueryClientProvider>,
  );
  expect(screen.queryByRole("combobox", { name: "Entry bot" })).toBeNull();
  expect(screen.getByText("Add a member first.")).toBeTruthy();
  await userEvent.click(screen.getByText("Add member"));
  await userEvent.type(await screen.findByLabelText("Add member"), "ops{Enter}");
  expect(screen.getByRole("combobox", { name: "Entry bot" }).textContent).toContain("Ops");
});
