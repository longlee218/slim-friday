import type { SkillLookupDto } from "@friday/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { InstallSkillSheet } from "../../../src/components/settings/skills/install-skill-sheet";
import { seededClient } from "../../shell/fixtures";

const api = vi.hoisted(() => ({ lookup: vi.fn(), install: vi.fn() }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
vi.mock("../../../src/api/client", async (orig) => ({
  ...(await orig<typeof import("../../../src/api/client")>()),
  client: { config: { skills: api } },
}));

const found: SkillLookupDto = {
  lookupId: "L1",
  source: "https://github.com/o/r",
  sha: "abc1234def",
  expiresAt: 0,
  skills: [
    { name: "debug", description: "Find the root cause", files: ["SKILL.md"], scripts: ["run.sh"] },
  ],
};

function setup(onInstalled = vi.fn()) {
  render(
    <QueryClientProvider client={seededClient({})}>
      <InstallSkillSheet open onOpenChange={() => {}} onInstalled={onInstalled} />
    </QueryClientProvider>,
  );
  return onInstalled;
}

const look = async (src: string) => {
  await userEvent.type(screen.getByLabelText("From"), src);
  await userEvent.click(screen.getByRole("button", { name: "Look up" }));
};

beforeEach(() => {
  vi.clearAllMocks();
  api.lookup.mockResolvedValue(found);
  api.install.mockResolvedValue({ name: "debug" });
});

test("an http source shows the server's field error and no result", async () => {
  api.lookup.mockRejectedValue({ code: "BAD_REQUEST", message: "https only" });
  setup();
  await look("http://github.com/o/r");
  expect(await screen.findByText("https only")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
});

test("nothing is installed before Install is clicked; scripts are flagged", async () => {
  setup();
  await look("https://github.com/o/r");
  expect(await screen.findByText("debug")).toBeTruthy();
  expect(screen.getByText(/runs code: run\.sh/)).toBeTruthy();
  expect(api.lookup).toHaveBeenCalledWith({ source: "https://github.com/o/r" });
  expect(api.install).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Install" }));
  await waitFor(() => expect(api.install).toHaveBeenCalledWith({ lookupId: "L1", name: "debug" }));
});

test("an expired lookup is shown with a way to look it up again", async () => {
  api.install.mockRejectedValue({
    code: "BAD_REQUEST",
    message: "not confirmed: look the source up again",
  });
  setup();
  await look("https://github.com/o/r");
  await userEvent.click(await screen.findByRole("button", { name: "Install" }));
  expect(await screen.findByText(/not confirmed/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Look up again" }));
  await waitFor(() => expect(api.lookup).toHaveBeenCalledTimes(2));
});
