import { expect, test } from "bun:test";
import type { BotMessenger, RunKind } from "@friday/core";
import type { ChatContext } from "../src/chat/chat-context";
import { chatTools } from "../src/chat/chat-server";

/** Names of the chat tools of one run kind, for a bot that can reach a group. */
const names = (runKind: RunKind) =>
  chatTools({
    runKind,
    effort: {},
    workspaces: [],
    messenger: {} as BotMessenger,
  } as unknown as ChatContext).map((t) => t.name);

test("owner: every chat tool as configured", () => {
  expect(names("owner")).toEqual(
    expect.arrayContaining([
      "PostFile",
      "SetEffort",
      "PostUpdate",
      "SendToBot",
      "HandOff",
      "UpdateProfile",
    ]),
  );
});

test("bot: no PostUpdate and no UpdateProfile, bot messaging stays", () => {
  const n = names("bot");
  expect(n).not.toContain("PostUpdate");
  expect(n).not.toContain("UpdateProfile");
  expect(n).toEqual(expect.arrayContaining(["SendToBot", "HandOff"]));
});

test("ticket: no PostUpdate, SendToBot, HandOff or UpdateProfile", () => {
  const n = names("ticket");
  for (const t of ["PostUpdate", "SendToBot", "HandOff", "UpdateProfile"])
    expect(n).not.toContain(t);
  expect(n).toContain("PostFile");
});

test("intro: only UpdateProfile of this server (AskUserQuestion is an SDK tool)", () => {
  expect(names("intro")).toEqual(["UpdateProfile"]);
});
