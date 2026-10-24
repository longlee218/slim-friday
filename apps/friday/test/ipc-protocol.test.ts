import { expect, test } from "bun:test";
import { parseMainToWorker, parseWorkerToMain } from "../src/workers/ipc-protocol";

test("ipc-protocol accepts the known worker messages", () => {
  const known = [
    { t: "ready" },
    { t: "post", messageId: 7, conversationId: "c1" },
    { t: "activity", conversationId: "c1", activity: { kind: "typing", botId: "b1" } },
    {
      t: "run_step",
      conversationId: "c1",
      botId: "b1",
      step: { id: "s", kind: "tool", label: "Read", state: "running", startedAt: 1 },
    },
    { t: "card", cardId: "k1" },
    { t: "hint", kind: "run", ids: ["w1"] },
  ];
  for (const m of known) expect(parseWorkerToMain(m)).toEqual(m as never);
});

test("ipc-protocol rejects unknown messages", () => {
  const bad: unknown[] = [
    null,
    "post",
    42,
    {},
    { t: "nope" },
    { t: "post", messageId: "7", conversationId: "c1" },
    { t: "post", messageId: 7 },
    { t: "hint", kind: "explode" },
    { t: "hint", kind: "run", ids: [1] },
    { t: "activity", conversationId: "c1", activity: { kind: "dance", botId: "b" } },
    { t: "card", cardId: "k", extra: true },
    // A main-only message is not a worker message.
    { t: "init", config: { agentHome: "/h", r2: {} } },
  ];
  for (const m of bad) expect(parseWorkerToMain(m)).toBeUndefined();
  expect(parseMainToWorker({ t: "post", messageId: 1, conversationId: "c" })).toBeUndefined();
  expect(parseMainToWorker({ t: "init" })).toBeUndefined();
  expect(parseMainToWorker({ t: "hint", kind: "config" })).toEqual({ t: "hint", kind: "config" });
  expect(parseMainToWorker({ t: "init", config: { agentHome: "/h", r2: {}, apiPort: 1 } })).toEqual(
    { t: "init", config: { agentHome: "/h", r2: {}, apiPort: 1 } } as never,
  );
});
