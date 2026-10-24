import { expect, test } from "bun:test";
import type { ProjectRulesReader } from "../src";
import { flush, makeHub } from "./bot-hub-harness";

const reader: ProjectRulesReader = async () => ({ file: "CLAUDE.md", text: "use bun" });

/** A hub whose group "g" works in /p (unless `bare`). */
function hubWith(read: ProjectRulesReader, bare = false) {
  const h = makeHub(undefined, { projectRules: read });
  const g = h.store.groupMap.get("g");
  if (g && !bare) g.workspaces = ["/p"];
  return h;
}

test.todo("group context goes with the first group turn, again only after a compaction (restored in Task 8)", async () => {
  const { runtime, surface } = hubWith(reader);
  surface.deliver({ conversationId: "gc", text: "one" });
  await flush();
  const s = runtime.nth(0);
  expect(s.sent[0]?.groupContext).toContain("/p");
  expect(s.sent[0]?.groupContext).toContain("use bun");
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  surface.deliver({ conversationId: "gc", text: "two" });
  await flush();
  expect(s.sent[1]?.groupContext).toBeUndefined();
  s.emit({ type: "turn_end", costUsd: 0 });
  s.emit({ type: "compacted" });
  await flush();
  surface.deliver({ conversationId: "gc", text: "three" });
  await flush();
  expect(s.sent[2]?.groupContext).toContain("use bun");
});

test.todo("a direct turn carries no group context (restored in Task 8)", async () => {
  const { runtime, surface } = hubWith(reader);
  surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  expect(runtime.nth(0).sent[0]?.groupContext).toBeUndefined();
});

test.todo("a throwing reader still sends the turn with the dirs (restored in Task 8)", async () => {
  const { runtime, surface } = hubWith(async () => Promise.reject(new Error("disk")));
  surface.deliver({ conversationId: "gc", text: "one" });
  await flush();
  const ctx = runtime.nth(0).sent[0]?.groupContext;
  expect(ctx).toContain("/p");
  expect(ctx).not.toContain("Project rules");
});

test.todo("a group with no workspaces and no instructions sends none (restored in Task 8)", async () => {
  const { runtime, surface } = hubWith(reader, true);
  surface.deliver({ conversationId: "gc", text: "one" });
  await flush();
  expect(runtime.nth(0).sent[0]?.groupContext).toBeUndefined();
});

test.todo("a group turn whose send fails sends the group context again on the next turn (restored in Task 8)", async () => {
  const { runtime, surface } = hubWith(reader);
  let failOnce = true;
  runtime.onTurn = () => {
    if (failOnce) {
      failOnce = false;
      throw new Error("unreadable attachment");
    }
  };
  surface.deliver({ conversationId: "gc", text: "one" });
  await flush();
  surface.deliver({ conversationId: "gc", text: "two" });
  await flush();
  expect(runtime.nth(0).sent[1]?.groupContext).toContain("use bun");
});
