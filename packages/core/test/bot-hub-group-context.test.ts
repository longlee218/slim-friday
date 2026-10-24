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

test("group context goes with every group run", async () => {
  const { runtime, surface } = hubWith(reader);
  surface.deliver({ conversationId: "gc", text: "one" });
  await flush();
  const first = runtime.last().sent[0];
  expect(first?.groupContext).toContain("/p");
  expect(first?.groupContext).toContain("use bun");
  runtime.last().emit({ type: "turn_end", costUsd: 0 });
  await flush();
  surface.deliver({ conversationId: "gc", text: "two" });
  await flush();
  expect(runtime.last().sent[0]?.groupContext).toContain("use bun");
  expect(runtime.turns()).toHaveLength(2);
});

test("a direct turn carries no group context", async () => {
  const { runtime, surface } = hubWith(reader);
  surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  expect(runtime.nth(0).sent[0]?.groupContext).toBeUndefined();
});

test("a throwing reader still sends the turn with the dirs", async () => {
  const { runtime, surface } = hubWith(async () => Promise.reject(new Error("disk")));
  surface.deliver({ conversationId: "gc", text: "one" });
  await flush();
  const ctx = runtime.nth(0).sent[0]?.groupContext;
  expect(ctx).toContain("/p");
  expect(ctx).not.toContain("Project rules");
});

test("a group with no workspaces and no instructions sends none", async () => {
  const { runtime, surface } = hubWith(reader, true);
  surface.deliver({ conversationId: "gc", text: "one" });
  await flush();
  expect(runtime.nth(0).sent[0]?.groupContext).toBeUndefined();
});

test("a group run whose send fails does not keep the next run from getting the group context", async () => {
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
  expect(runtime.last().sent[0]?.groupContext).toContain("use bun");
});
