import type { ApprovalRuleDto } from "@friday/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { orpc } from "../../src/api/client";
import { ApprovalRulesPanel, parseScope } from "../../src/components/settings/approval-rules-panel";
import { bot, seededClient } from "../shell/fixtures";

const api = vi.hoisted(() => ({
  add: vi.fn().mockResolvedValue({}),
  remove: vi.fn().mockResolvedValue({ ok: true }),
  setEffect: vi.fn().mockResolvedValue({}),
  toastError: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: api.toastError, success: vi.fn() }),
}));
vi.mock("../../src/api/client", async (orig) => ({
  ...(await orig<typeof import("../../src/api/client")>()),
  client: {
    config: { approvalRules: { add: api.add, remove: api.remove, setEffect: api.setEffect } },
  },
}));

const rules: ApprovalRuleDto[] = [
  {
    id: "r1",
    botId: "*",
    effect: "always_allow",
    match: "site",
    value: "example.com",
    scope: {},
    createdAt: 1,
  },
  {
    id: "r2",
    botId: "dev",
    effect: "require_approval",
    match: "tool",
    value: "GitPush",
    scope: { repo: "x" },
    createdAt: 2,
  },
];

function setup(list: ApprovalRuleDto[]) {
  const qc = seededClient({ bots: [bot("dev", "Dev")] });
  qc.setQueryData(orpc.config.approvalRules.list.queryKey(), list);
  qc.setQueryData(orpc.config.permissions.get.queryKey(), { autoReview: false });
  render(
    <QueryClientProvider client={qc}>
      <ApprovalRulesPanel />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());

test("lists each rule with its effect, match, value, bot and scope", () => {
  setup(rules);
  expect(screen.getByText("example.com")).toBeTruthy();
  expect(screen.getByText("Always allow", { selector: ".pill" })).toBeTruthy();
  expect(screen.getByText("Always ask", { selector: ".pill" })).toBeTruthy();
  expect(screen.getByText(/Site · All bots/)).toBeTruthy();
  expect(screen.getByText(/Tool · Dev · repo=x/)).toBeTruthy();
});

test("remove calls the API with the rule id", async () => {
  setup(rules);
  await userEvent.click(screen.getAllByRole("button", { name: "Remove rule" })[1] as HTMLElement);
  await waitFor(() => expect(api.remove).toHaveBeenCalledWith({ id: "r2" }));
});

test("clicking a rule's effect switches it to the other effect", async () => {
  setup(rules);
  await userEvent.click(screen.getByRole("button", { name: "Always ask: switch to Always allow" }));
  await waitFor(() =>
    expect(api.setEffect).toHaveBeenCalledWith({ id: "r2", effect: "always_allow" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Always allow: switch to Always ask" }));
  await waitFor(() =>
    expect(api.setEffect).toHaveBeenLastCalledWith({ id: "r1", effect: "require_approval" }),
  );
});

test("add sends effect, match, bot and value; a tool rule sends its scope", async () => {
  setup([]);
  expect(screen.getByText(/No rules yet/)).toBeTruthy();
  await userEvent.type(screen.getByLabelText("Value"), "example.com");
  await userEvent.click(screen.getByRole("button", { name: "Add rule" }));
  await waitFor(() =>
    expect(api.add).toHaveBeenCalledWith({
      botId: "*",
      effect: "require_approval",
      match: "site",
      value: "example.com",
    }),
  );
  await userEvent.selectOptions(screen.getByLabelText("Match"), "tool");
  await userEvent.selectOptions(screen.getByLabelText("Effect"), "always_allow");
  await userEvent.selectOptions(screen.getByLabelText("Bot"), "dev");
  await userEvent.type(screen.getByLabelText("Value"), "GitPush");
  await userEvent.type(screen.getByLabelText("Scope"), "repo=friday");
  await userEvent.click(screen.getByRole("button", { name: "Add rule" }));
  await waitFor(() =>
    expect(api.add).toHaveBeenLastCalledWith({
      botId: "dev",
      effect: "always_allow",
      match: "tool",
      value: "GitPush",
      scope: { repo: "friday" },
    }),
  );
});

test("a refused add shows the server's message", async () => {
  api.add.mockRejectedValueOnce(new Error("Use the site's registrable domain (e.g. example.com)."));
  setup([]);
  await userEvent.type(screen.getByLabelText("Value"), "a.example.com");
  await userEvent.click(screen.getByRole("button", { name: "Add rule" }));
  await waitFor(() =>
    expect(api.toastError).toHaveBeenCalledWith(
      "Use the site's registrable domain (e.g. example.com).",
    ),
  );
});

test("a note says scheduled runs read without asking", () => {
  setup([]);
  expect(
    screen.getByText(
      "Scheduled runs read web pages and read-only connector tools without asking, even where a rule says Require approval.",
    ),
  ).toBeTruthy();
});

test("parseScope reads key=value pairs", () => {
  expect(parseScope("")).toEqual({});
  expect(parseScope("repo=friday, branch=*")).toEqual({ repo: "friday", branch: "*" });
});
