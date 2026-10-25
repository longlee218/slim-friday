import { expect, test } from "bun:test";
import type { PostUpdateResult, RunKind } from "@friday/core";
import type { ChatContext } from "../src/chat/chat-context";
import { chatTools } from "../src/chat/chat-server";
import { createPostUpdateTool } from "../src/chat/tools/PostUpdateTool/post-update-tool";
import { call, textOf } from "./design-fixture";

/** A tool whose hub answers `r`; records the texts it was given. */
function make(r: PostUpdateResult) {
  const sent: string[] = [];
  const ctx = {
    postUpdate: async (t: string) => {
      sent.push(t);
      return r;
    },
  } as unknown as ChatContext;
  return { tool: createPostUpdateTool(ctx), sent };
}

test("a posted update says Posted; a cut one warns that only 500 chars arrived", async () => {
  const ok = make({ posted: true, cut: false });
  expect(textOf(await call(ok.tool, { message: "checking" }))).toBe("Posted.");
  expect(ok.sent).toEqual(["checking"]);
  const cut = make({ posted: true, cut: true });
  expect(textOf(await call(cut.tool, { message: "x".repeat(600) }))).toContain("cut off at 500");
});

test("fresh and budget both answer: not posted, put everything in the final reply", async () => {
  for (const reason of ["fresh", "budget"] as const) {
    const r = await call(make({ posted: false, reason }).tool, { message: "x" });
    expect(r.isError).toBeUndefined();
    expect(textOf(r)).toContain("This update was not posted");
  }
});

test("an empty message is refused", async () => {
  expect((await call(make({ posted: true, cut: false }).tool, { message: "  " })).isError).toBe(
    true,
  );
});

test("PostUpdate is offered to an owner run only", () => {
  const names = (runKind: RunKind) =>
    chatTools({ runKind, effort: {}, workspaces: [] } as unknown as ChatContext).map((t) => t.name);
  expect(names("owner")).toContain("PostUpdate");
  for (const k of ["bot", "ticket", "intro"] as const) expect(names(k)).not.toContain("PostUpdate");
});
