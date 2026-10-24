import { expect, test } from "bun:test";
import { effectKeyFor } from "../src/runs/effect-key";

test("effect key: same call and count give the same key; count, card, tool or input change it", async () => {
  const k = await effectKeyFor("w", undefined, "GitPush", { b: 1 }, 1);
  expect(k).toBe(await effectKeyFor("w", undefined, "GitPush", { b: 1 }, 1));
  expect(k.startsWith("w:-:GitPush:")).toBe(true);
  expect(k.endsWith(":1")).toBe(true);
  for (const other of [
    await effectKeyFor("w", undefined, "GitPush", { b: 1 }, 2),
    await effectKeyFor("w", "c1", "GitPush", { b: 1 }, 1),
    await effectKeyFor("w", undefined, "MergeBranch", { b: 1 }, 1),
    await effectKeyFor("w", undefined, "GitPush", { b: 2 }, 1),
  ])
    expect(other).not.toBe(k);
});
