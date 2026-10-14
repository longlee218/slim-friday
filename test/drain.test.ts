import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DRAIN_FILE, isDraining } from "../src/lifecycle/drain";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { makeEnv, resultMsg, TEST_CHANNEL } from "./helpers";

const msg = (text: string) => ({
  source: "t",
  language: "en" as const,
  channelId: TEST_CHANNEL,
  userId: "u",
  threadId: "th1",
  text,
});

test("isDraining: env FRIDAY_DRAIN=1 or a DRAIN file in AGENT_HOME", () => {
  const { home } = makeEnv();
  expect(isDraining(home, {})).toBe(false);
  expect(isDraining(home, { FRIDAY_DRAIN: "0" })).toBe(false);
  expect(isDraining(home, { FRIDAY_DRAIN: "1" })).toBe(true);
  writeFileSync(join(home, DRAIN_FILE), "");
  expect(isDraining(home, {})).toBe(true);
});

test("draining: a new task is refused with the deploy reply and starts no run or row; stop still answers", async () => {
  const env = makeEnv();
  let runs = 0;
  const handle = createTurnHandler({
    db: env.db,
    config: env.config,
    queryFn: (() => {
      runs++;
      return (async function* () {
        yield resultMsg();
      })();
    }) as never,
  });
  writeFileSync(join(env.home, DRAIN_FILE), "");
  expect(await handle(msg("what is x?"))).toBe("I’m updating. Please try again shortly.");
  expect(await handle(msg("stop"))).toBe("Nothing is running.");
  expect(runs).toBe(0);
  expect(env.db.query("SELECT COUNT(*) AS n FROM turns").get()).toEqual({ n: 0 });
});
