import { expect, test } from "bun:test";
import { createThreadTitlePort } from "../src/ingress/thread-rename";

/** Fake client whose thread `setName` is the given function. */
function client(setName: (n: string) => Promise<unknown>, name = "⏳ x") {
  return {
    channels: { fetch: async () => ({ isThread: () => true, name, setName }) },
  } as any;
}

test("M3: a setName that never resolves times out as failed", async () => {
  const port = createThreadTitlePort(() => client(() => new Promise(() => {})), 30);
  expect(await port.rename("t", "⏳ x", "new")).toBe("failed");
});

test("setName resolving in time is renamed; a rejection is failed; a changed name is kept", async () => {
  expect(
    await createThreadTitlePort(() => client(async () => {}), 30).rename("t", "⏳ x", "n"),
  ).toBe("renamed");
  expect(
    await createThreadTitlePort(
      () => client(() => Promise.reject(new Error("no perm"))),
      30,
    ).rename("t", "⏳ x", "n"),
  ).toBe("failed");
  expect(
    await createThreadTitlePort(() => client(async () => {}, "mine"), 30).rename("t", "⏳ x", "n"),
  ).toBe("kept");
});
