import type { BotDto, SkillDto, SkillLookupDto } from "@friday/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, expect, test, vi } from "vitest";
import { orpc } from "../../../src/api/client";
import { SkillDetail } from "../../../src/components/settings/skills/skill-detail";
import { bot, seededClient } from "../../shell/fixtures";

const api = vi.hoisted(() => ({
  lookup: vi.fn(),
  update: vi.fn(),
  checkUpdate: vi.fn(),
  remove: vi.fn(),
  setUsedBy: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
vi.mock("../../../src/api/client", async (orig) => ({
  ...(await orig<typeof import("../../../src/api/client")>()),
  client: { config: { skills: api } },
}));

const debug: SkillDto = {
  name: "debug",
  description: "Find the root cause",
  shipped: false,
  source: "https://github.com/o/r",
  path: "skills/debug",
  sha: "abcdef1234567",
  installedAt: Date.parse("2026-10-20T00:00:00Z"),
  files: ["SKILL.md", "run.sh"],
  body: "# Debug\n\n<script>alert(1)</script>\n\nSteps here",
  usedBy: ["dev", "tess"],
};
const lookup: SkillLookupDto = {
  lookupId: "L2",
  source: "https://github.com/o/r",
  sha: "f3b71d2aaaa",
  expiresAt: 0,
  skills: [{ name: "debug", description: "d", files: ["SKILL.md"], scripts: [] }],
};

function setup(skill: SkillDto = debug, bots: BotDto[] = [bot("dev", "Dev"), bot("tess", "Tess")]) {
  const qc = seededClient({ bots });
  qc.setQueryData(orpc.config.skills.list.queryKey(), [skill]);
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/settings/skills/${skill.name}`]}>
        <Routes>
          <Route path="/settings/skills/:name" element={<SkillDetail />} />
          <Route path="/settings/skills" element={<div>list page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.checkUpdate.mockResolvedValue({
    sha: "abcdef1",
    latestSha: "f3b71d2",
    updateAvailable: true,
  });
  api.lookup.mockResolvedValue(lookup);
  api.update.mockResolvedValue(debug);
  api.remove.mockResolvedValue({ botIds: ["dev", "tess"] });
  api.setUsedBy.mockResolvedValue(debug);
});

test("shows source, commit (7 chars), files and renders no raw HTML", async () => {
  setup();
  expect((await screen.findAllByText("abcdef1")).length).toBeGreaterThan(0);
  expect(screen.getAllByText("run.sh").length).toBeGreaterThan(0);
  expect(screen.getByText("Steps here")).toBeTruthy();
  expect(document.querySelector(".skill-body script")).toBeNull();
});

test("Remove's dialog names the bots that lose the skill", async () => {
  setup();
  await userEvent.click(await screen.findByRole("button", { name: "Remove" }));
  expect(await screen.findByText(/Dev, Tess lose it/)).toBeTruthy();
  expect(api.remove).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Remove skill" }));
  await waitFor(() => expect(api.remove).toHaveBeenCalledWith({ name: "debug" }));
});

test("Update runs lookup, shows it, then update with the new lookupId", async () => {
  setup();
  await userEvent.click(await screen.findByRole("button", { name: "Check for updates" }));
  await userEvent.click(await screen.findByRole("button", { name: "Update" }));
  await waitFor(() =>
    expect(api.lookup).toHaveBeenCalledWith({
      source: "https://github.com/o/r",
      path: "skills/debug",
    }),
  );
  expect(api.update).not.toHaveBeenCalled();
  await userEvent.click(await screen.findByRole("button", { name: "Update to f3b71d2" }));
  await waitFor(() => expect(api.update).toHaveBeenCalledWith({ lookupId: "L2", name: "debug" }));
});

test("a shipped skill can't be removed and has no update check", async () => {
  setup({ ...debug, shipped: true, source: undefined, sha: undefined, installedAt: undefined });
  expect(await screen.findByText(/can't be removed/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Check for updates" })).toBeNull();
});

test("a Used by switch sends the new bot list", async () => {
  setup();
  await userEvent.click(await screen.findByRole("switch", { name: "Tess uses debug" }));
  await waitFor(() =>
    expect(api.setUsedBy).toHaveBeenCalledWith({ name: "debug", botIds: ["dev"] }),
  );
});
