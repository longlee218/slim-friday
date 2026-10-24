import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEngineStore } from "@friday/store-sqlite";
import { FakeRuntime, type FakeSession } from "../../../packages/core/test/fakes/fake-runtime";
import { FakeDiscordPort } from "../../../packages/surface-discord/test/fake-discord-port";
import { startApp } from "../src/start-app";

const log = { info() {}, warn() {}, error() {} };
const stoppers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const s of stoppers.splice(0)) await s();
});

const botText = (name: string) => `---\nname: ${name}\ntitle: T\nmodel: sonnet\n---\nBe brief.\n`;

/** Write files under `<home>/config`. */
function put(home: string, files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    const f = join(home, "config", rel);
    mkdirSync(join(f, ".."), { recursive: true });
    writeFileSync(f, text);
  }
}

/** Start the app over fakes; each bot answers every turn with `reply:<name>`. */
async function boot(files: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "app-"));
  put(home, files);
  const port = new FakeDiscordPort();
  const runtime = new FakeRuntime();
  runtime.onTurn = (s: FakeSession) => {
    s.emit({ type: "text", text: `reply:${s.spec.bot.name}` });
    s.emit({ type: "turn_end", costUsd: 0 });
  };
  const app = await startApp({ port, runtime, agentHome: home, log });
  stoppers.push(() => app.stop());
  const channel = (name: string) => port.channels.find((c) => c.name === name)?.id ?? "";
  return { home, port, runtime, app, channel };
}

/** Wait until `fn` is true (the app reacts to files and messages asynchronously). */
async function until(fn: () => boolean, ms = 3000) {
  for (let t = 0; t < ms && !fn(); t += 25) await Bun.sleep(25);
  expect(fn()).toBe(true);
}

test("start: the Friday bot has a channel and says it is ready under its own name", async () => {
  const { port, channel } = await boot();
  expect(channel("friday")).not.toBe("");
  expect(port.sentAs).toContainEqual({
    channelId: channel("friday"),
    username: "Friday",
    text: "Ready. Talk to me here.",
  });
});

test("an owner message reaches Friday with the real dirs in its instructions and the reply is posted", async () => {
  const { home, port, runtime, channel } = await boot();
  port.emitMessage({ channelId: channel("friday"), text: "hi" });
  await until(() => port.sentAs.some((m) => m.text === "reply:Friday"));
  const instructions = runtime.nth(0).spec.bot.instructions;
  expect(instructions).toContain(join(home, "config"));
  expect(instructions).not.toContain("<config dir>");
  expect(instructions).not.toContain("<template dir>");
});

test("new bot and group files get channels without a restart", async () => {
  const { home, channel } = await boot();
  put(home, {
    "bots/ann.md": botText("Ann"),
    "groups/team.yaml": "name: Team\nmembers: [ann]\nentryBot: ann\n",
  });
  await until(() => channel("ann") !== "" && channel("team") !== "");
});

test("editing a bot stops its session and forgets the stored session id", async () => {
  const { home, port, runtime, app, channel } = await boot({ "bots/ann.md": botText("Ann") });
  port.emitMessage({ channelId: channel("ann"), text: "hi" });
  await until(() => runtime.opened.length === 1 && app.hub.status().length === 1);
  put(home, { "bots/ann.md": botText("Ann").replace("Be brief.", "Be long.") });
  await until(() => runtime.nth(0).stopped);
  expect(app.hub.status()).toEqual([]);
  const db = openEngineStore(join(home, "data", "engine.db"));
  expect(await db.sessions.get("ann")).toBeUndefined();
  db.close();
});

test("/status lists running bots; /stop in a bot's channel stops it", async () => {
  const { port, runtime, app, channel } = await boot({ "bots/ann.md": botText("Ann") });
  const c = channel("ann");
  expect(await port.emitCommand({ channelId: c, name: "status" })).toEqual(["No bot is running."]);
  port.emitMessage({ channelId: c, text: "hi" });
  await until(() => app.hub.status().length === 1);
  await until(() => !app.hub.status()[0]?.busy);
  expect(await port.emitCommand({ channelId: c, name: "status" })).toEqual([
    "Ann: idle, 0 background task(s)",
  ]);
  expect(await port.emitCommand({ channelId: c, name: "stop" })).toEqual(["Stopped Ann."]);
  expect(runtime.nth(0).stopped).toBe(true);
});

test("a group message with no mention reaches the entry bot only", async () => {
  const { port, runtime, channel } = await boot({
    "bots/ann.md": botText("Ann"),
    "bots/bob.md": botText("Bob"),
    "groups/team.yaml": "name: Team\nmembers: [ann, bob]\nentryBot: ann\n",
  });
  port.emitMessage({ channelId: channel("team"), text: "hello team" });
  await until(() => runtime.opened.length >= 1);
  await Bun.sleep(100);
  expect(runtime.opened.map((s) => s.spec.bot.id)).toEqual(["ann"]);
});

test("stop() resolves and stops the sessions", async () => {
  const { port, runtime, app, channel } = await boot();
  port.emitMessage({ channelId: channel("friday"), text: "hi" });
  await until(() => runtime.opened.length === 1);
  await app.stop();
  expect(runtime.nth(0).stopped).toBe(true);
});

test("startApp fails when the first channel sync cannot list the channels", async () => {
  const home = mkdtempSync(join(tmpdir(), "app-"));
  const port = new FakeDiscordPort();
  port.listChannels = async () => {
    throw new Error("discord 503");
  };
  await expect(
    startApp({ port, runtime: new FakeRuntime(), agentHome: home, log }),
  ).rejects.toThrow("discord 503");
});
