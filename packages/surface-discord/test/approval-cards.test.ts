import { expect, test } from "bun:test";
import type { ApprovalAnswer, ApprovalCard } from "@friday/core";
import { DiscordSurface } from "../src/discord-surface";
import { FakeDiscordPort } from "./fake-discord-port";

const card = (over: Partial<ApprovalCard> = {}): ApprovalCard => ({
  botName: "Ann",
  tool: "Bash",
  summary: "Bash cwd=/x",
  scope: {},
  offerAlways: true,
  ...over,
});
function setup() {
  const port = new FakeDiscordPort();
  const surface = new DiscordSurface(port, () => undefined);
  return { port, surface };
}
const settled = (p: Promise<ApprovalAnswer>) =>
  Promise.race([p, Bun.sleep(30).then(() => "pending" as const)]);

test("a card has three buttons when always-allow is offered, two without", async () => {
  const { port, surface } = setup();
  void surface.askApproval("ch1", card());
  void surface.askApproval("ch1", card({ offerAlways: false }));
  await Bun.sleep(5);
  expect(port.buttons[0]?.buttons.map((b) => b.label)).toEqual([
    "Allow once",
    "Always allow",
    "Deny",
  ]);
  expect(port.buttons[1]?.buttons.map((b) => b.label)).toEqual(["Allow once", "Deny"]);
  expect(port.buttons[0]?.text).toContain("Ann");
});

test("the owner's click resolves the answer and edits the card", async () => {
  const { port, surface } = setup();
  const p = surface.askApproval("ch1", card());
  await Bun.sleep(5);
  const always = port.buttons[0]?.buttons.find((b) => b.label === "Always allow");
  await port.emitClick("ch1", always?.id ?? "");
  expect(await p).toBe("always");
  expect(port.edits[0]?.text).toContain("always allowed");
  expect(port.edits[0]?.messageId).toBe(port.buttons[0]?.messageId ?? "");
});

test("a click by someone else changes nothing", async () => {
  const { port, surface } = setup();
  const p = surface.askApproval("ch1", card());
  await Bun.sleep(5);
  await port.emitClick("ch1", port.buttons[0]?.buttons[0]?.id ?? "", "stranger");
  expect(await settled(p)).toBe("pending");
  expect(port.edits).toEqual([]);
});

test("a repeated or unknown click changes nothing and does not throw", async () => {
  const { port, surface } = setup();
  const p = surface.askApproval("ch1", card());
  await Bun.sleep(5);
  const once = port.buttons[0]?.buttons[0]?.id ?? "";
  await port.emitClick("ch1", once);
  expect(await p).toBe("once");
  await port.emitClick("ch1", once);
  await port.emitClick("ch1", "appr:99:once");
  await port.emitClick("ch1", "garbage");
  expect(port.edits).toHaveLength(1);
});

test("two open cards never answer each other", async () => {
  const { port, surface } = setup();
  const p1 = surface.askApproval("ch1", card());
  const p2 = surface.askApproval("ch1", card());
  await Bun.sleep(5);
  await port.emitClick("ch1", port.buttons[1]?.buttons[0]?.id ?? "");
  expect(await p2).toBe("once");
  expect(await settled(p1)).toBe("pending");
});

test("a failing edit still resolves the answer", async () => {
  const { port, surface } = setup();
  const p = surface.askApproval("ch1", card());
  await Bun.sleep(5);
  port.failNext("editMessage");
  await port.emitClick("ch1", port.buttons[0]?.buttons[2]?.id ?? "");
  expect(await p).toBe("deny");
});

test("a card that cannot be posted rejects", async () => {
  const { port, surface } = setup();
  port.failNext("sendButtons");
  await expect(surface.askApproval("ch1", card())).rejects.toThrow();
});

test("cancelApprovals denies every open card and edits it", async () => {
  const { port, surface } = setup();
  const p = surface.askApproval("ch1", card());
  await Bun.sleep(5);
  await surface.cancelApprovals();
  expect(await p).toBe("deny");
  expect(port.edits[0]?.text).toContain("timed out");
});
