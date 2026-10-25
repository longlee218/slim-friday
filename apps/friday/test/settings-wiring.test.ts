import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS_DIR, FileConfig } from "@friday/config";
import { FileMemory } from "@friday/tools";
import { createSettings } from "../src/settings-admin";
import { until, webHarness } from "./web-harness";

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});
async function boot() {
  const h = await webHarness();
  stops.push(h.stop);
  return h;
}

const SCOUT = {
  name: "Scout",
  title: "T",
  instructions: "Be brief.",
  model: "sonnet",
  tools: [],
  skills: [],
  workspaces: [],
};

test("a bot saved through the API gets its conversation without a direct reload", async () => {
  const h = await boot();
  await h.client.config.bots.save({ id: "scout", bot: SCOUT, mode: "create" });
  const deadline = Date.now() + 2000;
  let ids: string[] = [];
  while (Date.now() < deadline && !ids.includes("bot:scout")) {
    ids = (await h.client.conversations.list()).map((c) => c.id);
    await Bun.sleep(20);
  }
  expect(ids).toContain("bot:scout");
});

test("on rules saved through the API reach the next session's prompt, off rules do not", async () => {
  const h = await boot();
  await h.client.config.bots.save({ id: "scout", bot: SCOUT, mode: "create" });
  await until(() => h.of("config.changed").length > 0);
  await h.client.memory.rules.save({
    owner: "bot:scout",
    rules: [
      { text: "A", on: true },
      { text: "B", on: false },
    ],
  });
  await h.client.chat.send({ conversationId: "bot:scout", text: "hi" });
  await until(() => h.runtime.opened.length === 1);
  const rules = h.runtime.nth(0).spec.rules ?? "";
  expect(rules).toBe("- A");
  expect(rules).not.toContain("B");
});

test("USER.md saved through the API resets no session and reaches the next run's system prompt", async () => {
  const h = await boot();
  h.runtime.onTurn = (s) => {
    s.emit({ type: "text", text: "ok" });
    s.emit({ type: "turn_end", costUsd: 0 });
  };
  await h.client.chat.send({ conversationId: "bot:friday", text: "one" });
  await until(() => h.runtime.opened.length === 1);
  const first = h.runtime.nth(0);
  await until(() => h.of("message").some((m) => m.message.text === "ok"));
  expect(first.spec.bot.instructions).not.toContain("I live in Hue.");
  const before = h.of("config.changed").length;
  await h.client.config.owner.save({ file: "USER", text: "I live in Hue." });
  await until(() => h.of("config.changed").length > before);
  await h.client.chat.send({ conversationId: "bot:friday", text: "two" });
  // Each run opens its session again: the same session is resumed (no reset), with the new owner text.
  await until(() => h.runtime.resumed.length === 1);
  expect(h.runtime.opened.length).toBe(1);
  expect(h.runtime.resumed[0]?.sessionId).toBe(first.id);
  expect(h.runtime.resumed[0]?.session.spec.bot.instructions).toContain("I live in Hue.");
});

/** Settings over a temp home with a scripted probe `query`; records the SDK options of every probe. */
function probeSettings(
  env: Record<string, string>,
  mcpProxy?: Parameters<typeof createSettings>[0]["mcpProxy"],
) {
  const home = mkdtempSync(join(tmpdir(), "settings-probe-"));
  const { config } = FileConfig.load({ defaultsDir: DEFAULTS_DIR, userDir: join(home, "config") });
  const options: Record<string, unknown>[] = [];
  /** What the probe dir held while each probe ran. */
  const dirsSeen: string[][] = [];
  const query = ((a: { options: Record<string, unknown> }) => {
    options.push(a.options);
    dirsSeen.push(readdirSync(String(a.options.cwd)));
    return {
      mcpServerStatus: async () => [{ name: "gh", status: "connected", tools: [{ name: "t" }] }],
      interrupt: async () => {},
      close: () => {},
    };
  }) as never;
  const settings = createSettings({
    config,
    agentHome: home,
    memory: new FileMemory(join(home, "memory")),
    capChars: 12000,
    env,
    pathEnv: "/usr/bin",
    probeQuery: query,
    ...(mcpProxy && { mcpProxy }),
  });
  return { settings, options, dirsSeen, home };
}

test("the probe refuses a server whose ${NAME} is missing, without starting it", async () => {
  const { settings, options } = probeSettings({ OTHER: "x" });
  const r = await settings.probe("gh", {
    type: "http",
    url: "https://x.example/mcp",
    headers: { Authorization: "Bearer ${GH_TOKEN}" },
  });
  expect(r).toEqual({ status: "failed", error: "needs GH_TOKEN" });
  expect(options.length).toBe(0);
});

test("the probe starts the expanded server with an env that holds no engine secret", async () => {
  const { settings, options } = probeSettings({
    GH_TOKEN: "ghp_abc",
    DISCORD_TOKEN: "secret",
    AUTH_SECRET: "secret",
    HOME: "/home/x",
  });
  const r = await settings.probe("gh", {
    type: "http",
    url: "https://x.example/mcp",
    headers: { Authorization: "Bearer ${GH_TOKEN}" },
  });
  expect(r).toEqual({ status: "connected", tools: ["t"] });
  expect(options[0]?.mcpServers).toEqual({
    gh: {
      type: "http",
      url: "https://x.example/mcp",
      headers: { Authorization: "Bearer ghp_abc" },
    },
  });
  expect(options[0]?.env).toEqual({ PATH: "/usr/bin", HOME: "/home/x" });
});

test("the probe runs in an empty private dir under the agent home, removed afterwards", async () => {
  const { settings, options, dirsSeen, home } = probeSettings({});
  await settings.probe("gh", { type: "stdio", command: "x" });
  const cwd = String(options[0]?.cwd);
  expect(cwd.startsWith(join(home, "data", "mcp-probe"))).toBe(true);
  expect(dirsSeen[0]).toEqual([]);
  expect(dirsSeen[0]).not.toContain(".env");
  expect(existsSync(cwd)).toBe(false);
});

test("the probe of an OAuth server goes through the local proxy, never to its url", async () => {
  const proxied = {
    type: "http" as const,
    url: "http://127.0.0.1:9/mcp/gh",
    headers: { "x-friday-mcp-key": "k" },
  };
  const { settings, options } = probeSettings({}, { configFor: () => proxied });
  // The scripted query answers for `gh`.
  await settings.probe("gh", { type: "http", url: "https://gh.example/mcp", oauth: {} });
  expect(options[0]?.mcpServers).toEqual({ gh: proxied });
});
