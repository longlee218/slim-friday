import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { orpc } from "../../src/api/client";
import { AvatarPicker } from "../../src/components/settings/avatar-picker";
import { GroupAvatar } from "../../src/components/settings/group-avatar";
import { bot } from "../shell/fixtures";

const m = vi.hoisted(() => ({
  create: vi.fn(),
  setBot: vi.fn().mockResolvedValue({}),
  setGroup: vi.fn().mockResolvedValue({}),
  encode: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock("../../src/components/settings/encode-avatar", async (orig) => ({
  ...(await orig<typeof import("../../src/components/settings/encode-avatar")>()),
  encodeAvatar: m.encode,
}));
vi.mock("../../src/api/client", async (orig) => ({
  ...(await orig<typeof import("../../src/api/client")>()),
  client: {
    config: {
      avatars: { create: m.create },
      bots: { setAvatar: m.setBot },
      groups: { setAvatar: m.setGroup },
    },
  },
}));

const presets = [
  { name: "lead", url: "/avatars/lead.webp" },
  { name: "dev", url: "/avatars/dev.webp" },
];

function setup(kind: "bot" | "group") {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  qc.setQueryData(orpc.config.avatars.list.queryKey(), presets);
  const onDone = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <AvatarPicker target={{ kind, id: "x" }} onDone={onDone}>
        <span>face</span>
      </AvatarPicker>
    </QueryClientProvider>,
  );
  return { onDone };
}
beforeEach(() => vi.clearAllMocks());

const open = () => userEvent.click(screen.getByRole("button", { name: "Change avatar" }));
const pick = (f: File) =>
  userEvent.upload(screen.getByLabelText("Upload image"), f, { applyAccept: false });

test("a 3 MB result shows too large and never asks for a ticket", async () => {
  m.encode.mockRejectedValue(new Error("too large"));
  setup("bot");
  await open();
  await pick(new File(["x"], "a.png", { type: "image/png" }));
  expect(await screen.findByText(/too large/i)).toBeTruthy();
  expect(m.create).not.toHaveBeenCalled();
});

test("choosing a preset calls setAvatar with the preset", async () => {
  const { onDone } = setup("bot");
  await open();
  await userEvent.click(await screen.findByRole("button", { name: "dev" }));
  await waitFor(() => expect(m.setBot).toHaveBeenCalledWith({ id: "x", preset: "dev" }));
  expect(onDone).toHaveBeenCalled();
});

test("an upload encodes, creates a ticket, PUTs the bytes, then sets uploadId", async () => {
  const blob = new Blob(["b"], { type: "image/jpeg" });
  m.encode.mockResolvedValue({ blob, type: "image/jpeg" });
  m.create.mockResolvedValue({ uploadId: "u-1", putUrl: "https://r2/put" });
  const put = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", put);
  setup("bot");
  await open();
  await pick(new File(["x"], "a.png", { type: "image/png" }));
  await waitFor(() => expect(m.setBot).toHaveBeenCalledWith({ id: "x", uploadId: "u-1" }));
  expect(m.create).toHaveBeenCalledWith({ kind: "bot", id: "x", size: 1, type: "image/jpeg" });
  expect(put.mock.calls[0]?.[0]).toBe("https://r2/put");
  expect(put.mock.calls[0]?.[1]).toMatchObject({ method: "PUT", body: blob });
  vi.unstubAllGlobals();
});

test("the group picker offers Member faces and sends none: true", async () => {
  setup("group");
  await open();
  await userEvent.click(await screen.findByRole("button", { name: "Member faces" }));
  await waitFor(() => expect(m.setGroup).toHaveBeenCalledWith({ id: "x", none: true }));
});

test("the bot picker has no Member faces", async () => {
  setup("bot");
  await open();
  await screen.findByRole("button", { name: "dev" });
  expect(screen.queryByRole("button", { name: "Member faces" })).toBeNull();
});

test("GroupAvatar shows the first three member faces when there is no avatar", () => {
  const bots = new Map(["a", "b", "c", "d"].map((id) => [id, bot(id, id.toUpperCase())]));
  const { container } = render(
    <GroupAvatar name="Crew" members={["a", "b", "c", "d"]} bots={bots} />,
  );
  expect(container.querySelectorAll("img")).toHaveLength(3);
  render(<GroupAvatar name="Pic" avatarUrl="/g.webp" members={["a"]} bots={bots} />);
  expect(screen.getByAltText("Pic")).toBeTruthy();
});
