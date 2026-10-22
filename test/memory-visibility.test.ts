import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { channelMemoryFile } from "../src/memory/channel-memory";
import { ensureHome } from "../src/memory/persona";
import { buildPromptContext } from "../src/memory/prompt-context";
import { captureLogs } from "../src/observability/logger";
import { loadWorkspaces } from "../src/workspaces/workspace-registry";
import { addLocation, makeEnv } from "./helpers";

const WS = "main";
const CH = "main-agent";

test("no cap: a huge root and channel memory log no truncation event and show their sizes in prompt.context", () => {
  const env = makeEnv();
  addLocation(env.home, "api");
  ensureHome(env.home, loadWorkspaces(env.home).workspaces);
  writeFileSync(`${env.home}/MEMORY.md`, `# r\n\n## s\n- ${"x".repeat(9000)}\n`);
  writeFileSync(channelMemoryFile(env.home, WS, CH), `# c\n\n## s\n- ${"y".repeat(9000)}\n`);
  const logs = captureLogs();
  buildPromptContext({ agentHome: env.home, workspace: WS, channel: CH, kind: "worker" });
  logs.stop();
  expect(logs.lines.some((l) => String(l.event).startsWith("memory.trunc"))).toBe(false);
  const ev = logs.lines.find((l) => l.event === "prompt.context")!;
  expect(ev.memoryRootChars as number).toBeGreaterThan(9000);
  expect(ev.memoryChannelChars as number).toBeGreaterThan(9000);
  expect(ev).not.toHaveProperty("memoryOverCap");
});
