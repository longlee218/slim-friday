import { ORPCError } from "@orpc/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { BotForm, type BotFormValue } from "../../src/components/settings/bot-form";
import { seededClient } from "../shell/fixtures";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

const dev: BotFormValue = {
  id: "dev",
  name: "Dev",
  title: "Builder",
  instructions: "Write code.",
  model: "sonnet",
  tools: ["Read"],
  skills: [],
  workspaces: [],
};

function setup(over: Partial<React.ComponentProps<typeof BotForm>> = {}) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const view = render(
    <QueryClientProvider client={seededClient({})}>
      <BotForm initial={dev} mode="update" tab="profile" onSave={onSave} {...over} />
    </QueryClientProvider>,
  );
  return { onSave, ...view };
}

const save = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
const revert = () => screen.getByRole("button", { name: "Revert" }) as HTMLButtonElement;

test("Save and Revert are disabled until a change", async () => {
  setup();
  expect(save().disabled).toBe(true);
  expect(revert().disabled).toBe(true);
  await userEvent.type(screen.getByLabelText("Title"), "!");
  expect(save().disabled).toBe(false);
  expect(revert().disabled).toBe(false);
});

test("Revert restores the saved values", async () => {
  setup();
  await userEvent.type(screen.getByLabelText("Title"), "!!");
  await userEvent.click(revert());
  expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Builder");
  expect(save().disabled).toBe(true);
});

test("a BAD_REQUEST for name shows under Name in the error style", async () => {
  const err = new ORPCError("BAD_REQUEST", { message: "Name is taken", data: { field: "name" } });
  const { onSave } = setup({
    initial: { ...dev, id: "", name: "" },
    mode: "create",
  });
  onSave.mockRejectedValue(err);
  await userEvent.type(screen.getByLabelText("Name"), "Dev");
  // No Id field: the id is made from the name.
  expect(screen.queryByLabelText("Id")).toBeNull();
  await userEvent.click(save());
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ id: "dev", name: "Dev" }));
  const help = await screen.findByText("Name is taken");
  expect(help.className).toContain("err");
  expect(screen.getByLabelText("Name").className).toContain("err");
});

test("Save is disabled while saving", async () => {
  const { onSave } = setup();
  let release: () => void = () => {};
  onSave.mockReturnValue(new Promise<void>((r) => (release = r)));
  await userEvent.type(screen.getByLabelText("Title"), "!");
  await userEvent.click(save());
  await waitFor(() => expect(save().disabled).toBe(true));
  release();
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
});

test("a shipped bot is read only: no save bar, inputs disabled", () => {
  setup({ shipped: true });
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  expect((screen.getByLabelText("Title") as HTMLInputElement).disabled).toBe(true);
});

test("an existing bot is renamed from the Name field and saved with the form; its id stays", async () => {
  const { onSave } = setup();
  const name = screen.getByLabelText("Name") as HTMLInputElement;
  expect(name.value).toBe("Dev");
  expect(screen.queryByText(/File id/)).toBeNull();
  await userEvent.clear(name);
  await userEvent.type(name, "Nhà phát triển");
  await userEvent.click(save());
  await waitFor(() =>
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ id: "dev", name: "Nhà phát triển" }),
    ),
  );
});

test("a shipped bot's name is read only", () => {
  setup({ shipped: true });
  expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(true);
});
