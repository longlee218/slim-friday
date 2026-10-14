import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLACEHOLDER } from "../src/config/agent-config";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { addLocation, clearWorkspaces, makeEnv, TEST_CHANNEL } from "./helpers";

// Live test: verifies the SDK honors `additionalDirectories` (open spike item for phase 02).
const key = process.env.OPENROUTER_API_KEY;
const live = !!key && key !== PLACEHOLDER;
if (!live) {
  process.stderr.write(
    "SKIP live multi-location smoke: OPENROUTER_API_KEY missing or REPLACE_ME\n",
  );
}

describe.skipIf(!live)("live multi-location smoke (OpenRouter)", () => {
  test("unpinned run reads a file from a second location via additionalDirectories", async () => {
    const env = makeEnv({
      OPENROUTER_API_KEY: key!,
      LLM_PROVIDER: "openrouter",
      MAX_TURNS: "8",
      TIMEOUT_MS: "90000",
    });
    const a = join(env.home, "alpha-location");
    const b = join(env.home, "beta-location");
    for (const p of [a, b]) mkdirSync(join(p, ".git"), { recursive: true });
    writeFileSync(join(a, "readme.txt"), "alpha location: nothing here\n");
    writeFileSync(join(b, "magic.txt"), "the magic number is 48271\n");
    clearWorkspaces(env.home);
    addLocation(env.home, "alpha", { description: "empty location" }, { path: a });
    addLocation(env.home, "beta", { description: "holds magic.txt" }, { path: b });

    const reply = await createTurnHandler({ db: env.db, config: env.config })({
      source: "test",
      channelId: TEST_CHANNEL,
      userId: "u",
      threadId: "live-multi1",
      text: `Use your Read tool to open ${join(b, "magic.txt")} and tell me the magic number. Answer with the number only.`,
    });
    expect(reply).toContain("48271");
  }, 120_000);
});
