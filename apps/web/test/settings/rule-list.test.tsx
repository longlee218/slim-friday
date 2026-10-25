import type { RuleDto } from "@friday/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { orpc } from "../../src/api/client";
import { RuleList } from "../../src/components/settings/rule-list";
import { bot, seededClient } from "../shell/fixtures";

const save = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
vi.mock("../../src/api/client", async (orig) => ({
  ...(await orig<typeof import("../../src/api/client")>()),
  client: { memory: { rules: { save } } },
}));

function setup(rules: RuleDto[]) {
  const qc = seededClient({ bots: [bot("dev", "Dev")] });
  qc.setQueryData(orpc.memory.rules.get.queryKey({ input: { owner: "bot:dev" } }), rules);
  render(
    <QueryClientProvider client={qc}>
      <RuleList owner="bot:dev" />
    </QueryClientProvider>,
  );
  return qc;
}

const three: RuleDto[] = [
  { text: "A rule", on: true },
  { text: "B rule", on: true },
  { text: "C rule", on: true },
];

beforeEach(() => vi.clearAllMocks());

test("states that rules come before memory", () => {
  setup(three);
  expect(screen.getByText(/Rules are always in Dev's prompt, before memory\./)).toBeTruthy();
});

test("turning a switch off saves that rule with on false and the same order", async () => {
  setup(three);
  await userEvent.click(screen.getAllByRole("switch", { name: "Rule on" })[1] as HTMLElement);
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({
      owner: "bot:dev",
      rules: [three[0], { text: "B rule", on: false }, three[2]],
    }),
  );
});

test("a failed save rolls the list back", async () => {
  save.mockRejectedValueOnce(new Error("no"));
  setup(three);
  await userEvent.click(screen.getAllByRole("switch", { name: "Rule on" })[0] as HTMLElement);
  await waitFor(() =>
    expect(
      screen.getAllByRole("switch", { name: "Rule on" })[0]?.getAttribute("aria-checked"),
    ).toBe("true"),
  );
});

test("keyboard reorder (space, arrow down, space) saves the moved order", async () => {
  setup(three);
  // jsdom has no layout: give every row a box so the keyboard sensor can find the next one.
  const rows = document.querySelectorAll<HTMLElement>("[data-rule]");
  rows.forEach((row, i) => {
    row.getBoundingClientRect = () =>
      ({
        top: i * 40,
        bottom: i * 40 + 40,
        left: 0,
        right: 300,
        width: 300,
        height: 40,
      }) as DOMRect;
  });
  const grips = screen.getAllByRole("button", { name: "Reorder rule" });
  (grips[0] as HTMLElement).focus();
  await userEvent.keyboard(" ");
  await userEvent.keyboard("{ArrowDown}");
  await userEvent.keyboard(" ");
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({
      owner: "bot:dev",
      rules: [three[1], three[0], three[2]],
    }),
  );
});

test("add row is disabled at 50 rules and the field caps at 500 chars", async () => {
  setup(Array.from({ length: 50 }, (_, i) => ({ text: `r${i}`, on: true })));
  const input = screen.getByPlaceholderText(/Add a rule/) as HTMLInputElement;
  expect(input.maxLength).toBe(500);
  await userEvent.type(input, "x");
  expect((screen.getByRole("button", { name: "Add rule" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});

test("add appends an on rule and saves the whole list", async () => {
  setup(three);
  await userEvent.type(screen.getByPlaceholderText(/Add a rule/), "D rule");
  await userEvent.click(screen.getByRole("button", { name: "Add rule" }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({
      owner: "bot:dev",
      rules: [...three, { text: "D rule", on: true }],
    }),
  );
});
