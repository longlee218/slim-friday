import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Bot, BotHub, type Group, PermissionGate } from "@friday/core";
import { WebSurface } from "@friday/surface-web";
import { createRouterClient } from "@orpc/server";
import { FakeClock } from "../../../core/test/fakes/fake-clock";
import { FakeFileStore } from "../../../core/test/fakes/fake-file-store";
import { FakeRuntime } from "../../../core/test/fakes/fake-runtime";
import { FakeStore } from "../../../core/test/fakes/fake-store";
import { FakeToolCatalog } from "../../../core/test/fakes/fake-tool-catalog";
import { fakeNextRunAt } from "../../../core/test/schedules/schedule-harness";
import type { ApiDeps, EngineDeps } from "../../src/index";
import { appRouter } from "../../src/index";
import { ticketChangePublisher } from "../../src/routers/tickets/ticket-publish";
import { FakeMcpAuth } from "./mcp-auth-fake";
import { fakeSettings } from "./settings-fakes";

/** A bot with only a name that matters. */
export const bot = (id: string, name: string): Bot => ({
  id,
  name,
  title: "",
  instructions: "",
  model: "m",
  tools: [],
  skills: [],
  subagents: [],
  workspaces: [],
});

/** The engine deps over fakes (hub, store, web surface, file store) and a router client on them. */
export function engineHarness() {
  const store = new FakeStore();
  const files = new FakeFileStore();
  const clock = new FakeClock(5000);
  const surface = new WebSurface({
    store,
    files,
    clock,
    inboxDir: mkdtempSync(join(tmpdir(), "api-inbox-")),
  });
  const gate = new PermissionGate({
    store,
    surface,
    clock,
    catalog: new FakeToolCatalog([]),
    settings: () => ({ level: "balanced" }),
  });
  const log = { info() {}, warn() {}, error() {} };
  // Same wiring as the app: every ticket change becomes a `ticket` event on the bus.
  const hub = new BotHub({
    runtime: new FakeRuntime(),
    surface,
    store,
    clock,
    gate,
    onTicketChange: ticketChangePublisher({ store, bus: surface.bus, log }),
    nextRunAt: fakeNextRunAt,
  });
  hub.start();
  const settings = fakeSettings();
  const deps = {
    hub,
    store,
    surface,
    files,
    purge: () => 0,
    settings,
    mcpAuth: new FakeMcpAuth(),
    now: () => clock.now(),
    limits: () => ({ maxSpendPerBotPerDayUsd: 10 }),
    log,
  } as unknown as ApiDeps;
  const client = createRouterClient(appRouter, {
    context: { session: { user: { email: "owner@example.com" } } as never, deps },
  });
  // A bot or group goes to the store and to the fake config admin, which `config.*` reads.
  const addBot = (id: string, name: string) => {
    store.botMap.set(id, bot(id, name));
    const { subagents: _s, ...input } = bot(id, name);
    settings.config.bots.set(id, { ...input, shipped: false });
  };
  const addGroup = (g: Partial<Group> & { id: string; name: string }) => {
    const full = { members: [], entryBot: "", workspaces: [], instructions: "", ...g };
    store.groupMap.set(g.id, full);
    settings.config.groups.set(g.id, full);
  };
  return { store, settings, files, surface, hub, client, deps, addBot, addGroup };
}

/** Just the engine fields of `ApiDeps`, over the same fakes (for tests that build the app themselves). */
export function fakeEngine(): EngineDeps {
  const { hub, store, surface, files, settings, deps } = engineHarness();
  return {
    mcpAuth: deps.mcpAuth,
    hub,
    store,
    surface,
    files,
    purge: () => 0,
    settings,
    limits: () => ({ maxSpendPerBotPerDayUsd: 10 }),
  };
}
