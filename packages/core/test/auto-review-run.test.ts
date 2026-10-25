import { expect, test } from "bun:test";
import type { AutoReviewer, PermissionGateDeps } from "../src";
import { flush, makeHub } from "./bot-hub-harness";

const LS = { tool: "Bash", input: { command: "ls" } };

/** A hub whose gate has Auto Review on with a reviewer that always passes; `seen` counts its calls. */
async function reviewedHub() {
  const h = makeHub();
  h.editor.tools = ["Bash"];
  let seen = 0;
  const autoReviewer: AutoReviewer = {
    review: async () => {
      seen++;
      return { decision: "pass", reason: "fits" };
    },
  };
  // The harness gate, switched on: settings are read at every call.
  Object.assign((h.gate as unknown as { deps: PermissionGateDeps }).deps, {
    autoReviewer,
    settings: () => ({ level: "balanced", autoReview: true }),
  });
  h.surface.deliver({ conversationId: "dc", text: "list files" });
  await flush();
  return { ...h, seen: () => seen };
}

test("a clean main-thread ask of a run is reviewed and passes", async () => {
  const h = await reviewedHub();
  expect(await h.runtime.last().spec.decide(LS)).toEqual({ behavior: "allow" });
  expect(h.seen()).toBe(1);
});

test("a subagent call (taskId) of a clean run is never reviewed: it parks", async () => {
  const h = await reviewedHub();
  const d = await h.runtime.last().spec.decide({ ...LS, taskId: "t1" });
  expect(d.behavior).toBe("park");
  expect(h.seen()).toBe(0);
});
