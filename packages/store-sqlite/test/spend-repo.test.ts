import { expect, test } from "bun:test";
import { openEngineStore } from "../src/engine-store";

test("spend.range is inclusive on both days, ordered by day then bot", async () => {
  const s = openEngineStore(":memory:");
  await s.spend.add("b1", "2026-10-20", 1);
  await s.spend.add("b2", "2026-10-21", 2);
  await s.spend.add("b1", "2026-10-21", 3);
  await s.spend.add("b1", "2026-10-22", 4);
  await s.spend.add("b1", "2026-10-23", 5);
  expect(await s.spend.range("2026-10-21", "2026-10-22")).toEqual([
    { botId: "b1", day: "2026-10-21", usd: 3 },
    { botId: "b2", day: "2026-10-21", usd: 2 },
    { botId: "b1", day: "2026-10-22", usd: 4 },
  ]);
});
