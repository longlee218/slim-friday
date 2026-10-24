import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEMPLATES_DIR } from "@friday/config";
import { openEngineStore, openMemoryIndex } from "@friday/store-sqlite";
import type { BusItem } from "@friday/surface-web";
import { FakeRuntime, type FakeSession } from "../../../packages/core/test/fakes/fake-runtime";
import { startApp } from "../src/start-app";
import { webParts } from "./web-fixture";

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

/** Start the app over fakes; each bot answers every turn with `reply:<name>`. Records every bus event. */
async function boot(files: Record<string, string> = {}, before?: (home: string) => void) {
  const home = mkdtempSync(join(tmpdir(), "app-"));
  put(home, files);
  before?.(home);
  const { engine, files: fileStore, surface } = webParts(home);
  const events: BusItem["event"][] = [];
  const ac = new AbortController();
  void (async () => {
    for await (const i of surface.bus.subscribe(undefined, ac.signal)) events.push(i.event);
  })();
  const runtime = new FakeRuntime();
  runtime.onTurn = (s: FakeSession) => {
    s.emit({ type: "text", text: `reply:${s.spec.bot.name}` });
    s.emit({ type: "turn_end", costUsd: 0 });
  };
  // As the engine wires it: a reload tells the web app through the bus.
  const app = await startApp({
    surface,
    files: fileStore,
    engine,
    runtime,
    agentHome: home,
    log,
    onConfigChanged: () => surface.bus.publish({ type: "config.changed" }),
  });
  stoppers.push(async () => {
    ac.abort();
    await app.stop();
  });
  /** Texts of the messages published in a conversation. */
  const texts = (conversationId: string) =>
    events.flatMap((e) =>
      e.type === "message" && e.conversationId === conversationId ? [e.message.text] : [],
    );
  /** Send an owner message (fire and forget, like a browser tab). */
  const say = (conversationId: string, text: string) =>
    void surface.send({ conversationId, text }).catch(() => undefined);
  return { home, engine, events, texts, say, runtime, app };
}

/** Wait until `fn` is true (the app reacts to files and messages asynchronously). */
async function until(fn: () => boolean | Promise<boolean>, ms = 3000) {
  for (let t = 0; t < ms && !(await fn()); t += 25) await Bun.sleep(25);
  expect(await fn()).toBe(true);
}

test("start: chat-app-keyed conversations are deleted; each bot and group gets its fixed conversation", async () => {
  const legacy = "123456789012345678";
  const { engine, texts } = await boot({}, (home) => {
    mkdirSync(join(home, "data"), { recursive: true });
    const db = openEngineStore(join(home, "data", "engine.db"));
    void db.conversations.put({ id: legacy, kind: "direct", botId: "friday" });
    void db.messages.append({
      conversationId: legacy,
      author: { kind: "user" },
      text: "old",
      at: 1,
    });
    db.close();
  });
  expect(await engine.conversations.get(legacy)).toBeUndefined();
  expect(await engine.messages.recent(legacy, 10)).toEqual([]);
  expect(await engine.conversations.get("bot:friday")).toEqual({
    id: "bot:friday",
    kind: "direct",
    botId: "friday",
  });
  const stored = await engine.messages.recent("bot:friday", 10);
  expect(stored.map((m) => [m.author, m.text])).toEqual([
    [{ kind: "bot", botId: "friday" }, "Ready. Talk to me here."],
  ]);
  expect(texts("bot:friday")).toEqual(["Ready. Talk to me here."]);
});

test("a restart greets no conversation twice", async () => {
  const first = await boot();
  await first.app.stop();
  const { home } = first;
  const { engine, files, surface } = webParts(home);
  const app = await startApp({
    surface,
    files,
    engine,
    runtime: new FakeRuntime(),
    agentHome: home,
    log,
  });
  stoppers.push(() => app.stop());
  expect((await engine.messages.recent("bot:friday", 10)).length).toBe(1);
});

test("an owner message reaches Friday with the real template dir in its instructions and the reply is posted", async () => {
  const { say, texts, runtime } = await boot();
  say("bot:friday", "hi");
  await until(() => texts("bot:friday").includes("reply:Friday"));
  const instructions = runtime.nth(0).spec.bot.instructions;
  expect(instructions).toContain(TEMPLATES_DIR);
  expect(instructions).not.toContain("<config dir>");
  expect(instructions).not.toContain("<template dir>");
});

test("a config reload adds bot:<id> and group:<id> and publishes config.changed", async () => {
  const { home, engine, events, texts } = await boot();
  put(home, {
    "bots/ann.md": botText("Ann"),
    "groups/team.yaml": "name: Team\nmembers: [ann]\nentryBot: ann\n",
  });
  await until(() => events.some((e) => e.type === "config.changed"));
  expect(await engine.conversations.get("bot:ann")).toBeDefined();
  expect(await engine.conversations.get("group:team")).toBeDefined();
  expect(texts("group:team")).toEqual(["Group ready: @Ann"]);
});

test("editing a bot: the running run keeps its session; the next open starts a fresh one", async () => {
  const { home, say, runtime, app, engine } = await boot({ "bots/ann.md": botText("Ann") });
  // The first run stays busy (no turn end), so the edit finds it running.
  runtime.onTurn = (s: FakeSession) => s.emit({ type: "text", text: "working" });
  say("bot:ann", "hi");
  await until(() => runtime.opened.length === 1);
  put(home, { "bots/ann.md": botText("Ann").replace("Be brief.", "Be long.") });
  await until(async () => (await engine.scopes.get("ann"))?.resetPending === true);
  // The run was not stopped by the edit.
  expect(runtime.nth(0).stopped).toBe(false);
  expect((await app.hub.status()).length).toBe(1);
  await app.hub.stop("ann");
  runtime.onTurn = (s: FakeSession) => s.emit({ type: "turn_end", costUsd: 0 });
  say("bot:ann", "again");
  await until(() => runtime.opened.length === 2);
  expect((await engine.scopes.get("ann"))?.resetPending).toBe(false);
});

test("removing a bot cancels its running run and forgets its session id", async () => {
  const { home, say, runtime, app, engine } = await boot({ "bots/ann.md": botText("Ann") });
  runtime.onTurn = (s: FakeSession) => s.emit({ type: "text", text: "working" });
  say("bot:ann", "hi");
  await until(() => runtime.opened.length === 1);
  rmSync(join(home, "config", "bots", "ann.md"));
  await until(() => runtime.nth(0).stopped);
  await until(async () => (await app.hub.status()).length === 0);
  expect(await engine.sessions.get("ann")).toBeUndefined();
});

test("a group message with no mention reaches the entry bot only", async () => {
  const { say, runtime } = await boot({
    "bots/ann.md": botText("Ann"),
    "bots/bob.md": botText("Bob"),
    "groups/team.yaml": "name: Team\nmembers: [ann, bob]\nentryBot: ann\n",
  });
  say("group:team", "hello team");
  await until(() => runtime.opened.length >= 1);
  await Bun.sleep(100);
  expect(runtime.opened.map((s) => s.spec.bot.id)).toEqual(["ann"]);
});

test("stop() resolves and stops the sessions", async () => {
  const { say, runtime, app } = await boot();
  say("bot:friday", "hi");
  await until(() => runtime.opened.length === 1);
  await app.stop();
  expect(runtime.nth(0).stopped).toBe(true);
});

test("startApp fails when the first conversation sync fails", async () => {
  const home = mkdtempSync(join(tmpdir(), "app-"));
  const { engine, files, surface } = webParts(home);
  engine.conversations.put = async () => {
    throw new Error("db down");
  };
  await expect(
    startApp({ surface, files, engine, runtime: new FakeRuntime(), agentHome: home, log }),
  ).rejects.toThrow("db down");
});

test("a bot's saved memory reaches its session spec", async () => {
  const { say, runtime } = await boot({}, (home) => {
    mkdirSync(join(home, "memory", "bots", "friday"), { recursive: true });
    writeFileSync(
      join(home, "memory", "bots", "friday", "MEMORY.md"),
      "## Facts\n- owner likes tea\n",
    );
  });
  say("bot:friday", "hi");
  await until(() => runtime.opened.length > 0);
  expect(runtime.nth(0).spec.memory).toContain("owner likes tea");
});

test("changing a group's workspaces marks each member's group scope for a fresh session; the direct one stays", async () => {
  const group = "name: Team\nmembers: [ann]\nentryBot: ann\n";
  const { home, say, runtime, engine } = await boot({
    "bots/ann.md": botText("Ann"),
    "groups/team.yaml": group,
  });
  say("bot:ann", "hi");
  say("group:team", "hi team");
  await until(() => runtime.opened.length === 2);
  const ws = mkdtempSync(join(tmpdir(), "ws-"));
  put(home, { "groups/team.yaml": `${group}workspaces: [${ws}]\n` });
  await until(async () => (await engine.scopes.get("ann@team"))?.resetPending === true);
  expect((await engine.scopes.get("ann"))?.resetPending).toBeFalsy();
  expect(await engine.sessions.get("ann@team")).toBeDefined();
});

test("a group session names only its group's roster and shared dir; the direct one names all", async () => {
  const { home, say, runtime } = await boot({
    "bots/ann.md": botText("Ann"),
    "bots/bob.md": botText("Bob"),
    "groups/team.yaml": "name: Team\nmembers: [ann]\nentryBot: ann\n",
    "groups/crew.yaml": "name: Crew\nmembers: [ann, bob]\nentryBot: bob\n",
  });
  say("bot:ann", "hi");
  say("group:team", "hi team");
  await until(() => runtime.opened.length === 2);
  const direct = runtime.opened.find((s) => !s.spec.groupId)?.spec.bot.instructions ?? "";
  const team = runtime.opened.find((s) => s.spec.groupId === "team")?.spec.bot.instructions ?? "";
  for (const t of ['group "Team"', 'group "Crew"', join(home, "shared", "team")])
    expect(direct).toContain(t);
  expect(direct).toContain(join(home, "shared", "crew"));
  expect(team).toContain('group "Team"');
  expect(team).toContain(join(home, "shared", "team"));
  expect(team).not.toContain('group "Crew"');
  expect(team).not.toContain(join(home, "shared", "crew"));
});

test("a start that fails after opening the db and the memory index closes both", async () => {
  const home = mkdtempSync(join(tmpdir(), "app-"));
  const { engine, files, surface } = webParts(home);
  const memoryIndex = openMemoryIndex(join(home, "data", "memory-index.db"));
  let indexClosed = false;
  const closeIndex = memoryIndex.close.bind(memoryIndex);
  memoryIndex.close = () => {
    indexClosed = true;
    closeIndex();
  };
  const runtime = () => {
    throw new Error("no runtime");
  };
  await expect(
    startApp({ surface, files, engine, runtime, memoryIndex, agentHome: home, log }),
  ).rejects.toThrow("no runtime");
  expect(indexClosed).toBe(true);
  // A closed bun:sqlite db refuses every query.
  await expect(engine.conversations.list()).rejects.toThrow();
});

test("a config that cannot load closes the given db", async () => {
  const home = mkdtempSync(join(tmpdir(), "app-"));
  const { engine, files, surface } = webParts(home);
  // A file where the config dir must be: loading it throws.
  writeFileSync(join(home, "config"), "not a dir");
  await expect(
    startApp({ surface, files, engine, runtime: new FakeRuntime(), agentHome: home, log }),
  ).rejects.toThrow();
  await expect(engine.conversations.list()).rejects.toThrow();
});
