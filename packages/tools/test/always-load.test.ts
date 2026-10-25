import { expect, test } from "bun:test";
import { FakeStore } from "../../core/test/fakes/fake-store";
import type { ChatContext } from "../src/chat/chat-context";
import { createHandOffTool } from "../src/chat/tools/HandOffTool/hand-off-tool";
import { createPostUpdateTool } from "../src/chat/tools/PostUpdateTool/post-update-tool";
import { createSendToBotTool } from "../src/chat/tools/SendToBotTool/send-to-bot-tool";
import { createScratchpadAddTool } from "../src/scratchpad/tools/ScratchpadAddTool/scratchpad-add-tool";
import { createScratchpadCompleteTool } from "../src/scratchpad/tools/ScratchpadCompleteTool/scratchpad-complete-tool";
import { createScratchpadListTool } from "../src/scratchpad/tools/ScratchpadListTool/scratchpad-list-tool";
import { createScratchpadRemoveTool } from "../src/scratchpad/tools/ScratchpadRemoveTool/scratchpad-remove-tool";
import { createScratchpadUpdateTool } from "../src/scratchpad/tools/ScratchpadUpdateTool/scratchpad-update-tool";

/** The SDK `tool()` helper stores `alwaysLoad` in `_meta` under this key. */
const KEY = "anthropic/alwaysLoad";
const chat = {} as ChatContext;
const pad = { botId: "a", scopeKey: "a", store: new FakeStore(), now: () => 1 };

test("the core tools are always loaded, never deferred behind tool search", () => {
  const core = [
    createPostUpdateTool(chat),
    createSendToBotTool(chat),
    createHandOffTool(chat),
    createScratchpadListTool(pad),
    createScratchpadAddTool(pad),
    createScratchpadUpdateTool(pad),
    createScratchpadCompleteTool(pad),
  ];
  for (const t of core) expect(t._meta?.[KEY]).toBe(true);
  // ScratchpadRemove is not one of the core tools.
  expect(createScratchpadRemoveTool(pad)._meta?.[KEY]).toBeUndefined();
});
