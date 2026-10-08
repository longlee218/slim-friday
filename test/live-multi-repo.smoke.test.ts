import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLACEHOLDER } from "../src/config/agent-config";
import { createTaskHandler } from "../src/tasks/handle-task";
import { addRepo, clearWorkspaces, makeEnv } from "./helpers";

// Live test: verifies the SDK honors `additionalDirectories` (open spike item for phase 02).
const key = process.env.OPENROUTER_API_KEY;
const live = !!key && key !== PLACEHOLDER;
if (!live) {
  process.stderr.write("SKIP live multi-repo smoke: OPENROUTER_API_KEY missing or REPLACE_ME\n");
}

describe.skipIf(!live)("live multi-repo smoke (OpenRouter)", () => {
  test("unpinned run reads a file from a second repo via additionalDirectories", async () => {
    const env = makeEnv({
      OPENROUTER_API_KEY: key!,
      LLM_PROVIDER: "openrouter",
      MAX_TURNS: "8",
      TIMEOUT_MS: "90000",
    });
    const a = join(env.home, "alpha-repo");
    const b = join(env.home, "beta-repo");
    for (const p of [a, b]) mkdirSync(join(p, ".git"), { recursive: true });
    writeFileSync(join(a, "readme.txt"), "alpha repo: nothing here\n");
    writeFileSync(join(b, "magic.txt"), "the magic number is 48271\n");
    clearWorkspaces(env.home);
    addRepo(env.home, "alpha", { description: "empty repo" }, { path: a });
    addRepo(env.home, "beta", { description: "holds magic.txt" }, { path: b });

    const reply = await createTaskHandler({ db: env.db, config: env.config })({
      source: "test",
      userId: "u",
      threadId: "live-multi1",
      text: `Use your Read tool to open ${join(b, "magic.txt")} and tell me the magic number. Answer with the number only.`,
    });
    expect(reply).toContain("48271");
  }, 120_000);
});
