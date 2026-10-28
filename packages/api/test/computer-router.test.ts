import { expect, test } from "bun:test";
import { type ComputerSpec, type ComputerView, OWNER_HOLDER, withInputLease } from "@friday/core";
import { Hono } from "hono";
import type { ComputerDesk } from "../src/computer/computer-desk";
import { createViewProxy } from "../src/computer/view-proxy";
import { openViewToken } from "../src/computer/view-token";
import { bot, engineHarness } from "./helpers/engine-deps";

const SECRET = "k".repeat(32);

/** A harness with bot `a` on computer `rt-comp`, bot `b` without one, and a fake provider. */
function setup(opts: { running?: boolean; publicApiUrl?: string } = {}) {
  const h = engineHarness();
  h.store.botMap.set("a", { ...bot("a", "Ann"), computer: "rt-comp" });
  h.store.botMap.set("b", bot("b", "Ben"));
  const calls: { view: { spec: ComputerSpec; viewOnly: boolean }[]; ensure: number } = {
    view: [],
    ensure: 0,
  };
  const desk: ComputerDesk = {
    provider: {
      running: async () => opts.running ?? true,
      view: async (spec, o): Promise<ComputerView> => {
        calls.view.push({ spec, viewOnly: o.viewOnly });
        return { url: "http://127.0.0.1:41000/#ticket=t1", port: 41000, expiresAt: 5000 + 900_000 };
      },
    },
    spec: (name) => ({ name, cpus: 2, memoryMb: 1536 }),
    slots: () => ({ limit: 2, text: "2 slots" }),
  };
  Object.assign(h.deps, {
    computers: desk,
    viewSecret: SECRET,
    ...(opts.publicApiUrl && { publicApiUrl: opts.publicApiUrl }),
  });
  return { ...h, calls };
}

const lease = (h: ReturnType<typeof setup>) => ({
  holds: h.store.computerHolds,
  clock: { now: h.deps.now },
  sleep: async () => {},
});

test("status of a bot without a computer; unknown bot is NOT_FOUND", async () => {
  const h = setup();
  expect(await h.client.computer.status({ botId: "b" })).toEqual({
    running: false,
    slots: { used: 0, limit: 2, text: "2 slots" },
    control: { holder: "none" },
  });
  await expect(h.client.computer.status({ botId: "zz" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await expect(h.client.computer.view({ botId: "b", mode: "view" })).rejects.toMatchObject({
    code: "NOT_FOUND",
    message: expect.stringContaining("no computer"),
  });
});

test("status maps the owner hold to holder owner", async () => {
  const h = setup();
  await h.client.computer.takeControl({ botId: "a" });
  const s = await h.client.computer.status({ botId: "a" });
  expect(s.computer).toBe("rt-comp");
  expect(s.running).toBe(true);
  expect(s.control.holder).toBe("owner");
  expect(s.control.botId).toBeUndefined();
});

test("view returns a sealed path, never the loopback address; the base is prefixed when set", async () => {
  const h = setup();
  const v = await h.client.computer.view({ botId: "a", mode: "view" });
  expect(v.url).not.toContain("127.0.0.1");
  expect(v.url.startsWith("/computer-view/")).toBe(true);
  expect(v.url).toContain("/viewer/");
  expect(h.calls.view[0]?.viewOnly).toBe(true);
  const token = v.url.split("/")[2] as string;
  const claims = openViewToken(SECRET, token, h.deps.now());
  expect(claims).toMatchObject({
    computer: "rt-comp",
    botId: "a",
    port: 41000,
    iat: 5000,
    mode: "view",
  });
  expect((claims?.exp ?? 0) - 5000).toBeLessThanOrEqual(600_000);
  expect(v.expiresAt).toBe(claims?.exp as number);

  const abs = setup({ publicApiUrl: "https://api.example.com/" });
  const w = await abs.client.computer.view({ botId: "a", mode: "view" });
  expect(w.url.startsWith("https://api.example.com/computer-view/")).toBe(true);
});

test("view on a stopped computer starts nothing and says so", async () => {
  const h = setup({ running: false });
  await expect(h.client.computer.view({ botId: "a", mode: "view" })).rejects.toMatchObject({
    code: "CONFLICT",
    message: expect.stringContaining("not running"),
  });
  expect(h.calls.view).toEqual([]);
  expect(h.calls.ensure).toBe(0);
});

test("control mode needs the owner's hold", async () => {
  const h = setup();
  await expect(h.client.computer.view({ botId: "a", mode: "control" })).rejects.toMatchObject({
    code: "CONFLICT",
  });
  await h.client.computer.takeControl({ botId: "a" });
  const v = await h.client.computer.view({ botId: "a", mode: "control" });
  const claims = openViewToken(SECRET, v.url.split("/")[2] as string, h.deps.now());
  expect(claims?.mode).toBe("control");
  expect((claims?.exp ?? 0) - (claims?.iat ?? 0)).toBe(60_000);
  expect(h.calls.view[0]?.viewOnly).toBe(false);
});

test("takeControl refuses a bot's input lease; double take is idempotent", async () => {
  const h = setup();
  const a = await h.client.computer.takeControl({ botId: "a" });
  const b = await h.client.computer.takeControl({ botId: "a" });
  expect(b.expiresAt).toBeGreaterThanOrEqual(a.expiresAt);
  const live = (await h.store.computerHolds.live(h.deps.now())).filter((x) => x.kind === "input");
  expect(live).toHaveLength(1);
  expect(live[0]?.holder).toBe(OWNER_HOLDER);
  await expect(
    withInputLease(lease(h), { computer: "rt-comp", botId: "a", holder: "run1" }, async () => 1),
  ).rejects.toMatchObject({ name: "ComputerOwnerControlError" });
});

test("renewControl after expiry is ok:false; before it extends", async () => {
  const h = setup();
  expect(await h.client.computer.renewControl({ botId: "a" })).toEqual({ ok: false });
  await h.client.computer.takeControl({ botId: "a" });
  const r = await h.client.computer.renewControl({ botId: "a" });
  expect(r.ok).toBe(true);
  expect(r.expiresAt).toBeGreaterThan(h.deps.now());
  const now = h.deps.now;
  h.deps.now = () => now() + 60_000;
  expect(await h.client.computer.renewControl({ botId: "a" })).toEqual({ ok: false });
});

test("giveBack is idempotent and revokes the computer's view tokens", async () => {
  const h = setup();
  await h.client.computer.takeControl({ botId: "a" });
  const link = await h.client.computer.view({ botId: "a", mode: "control" });
  expect(await h.client.computer.giveBack({ botId: "a" })).toEqual({ ok: true });
  expect(await h.client.computer.giveBack({ botId: "a" })).toEqual({ ok: true });
  expect((await h.client.computer.status({ botId: "a" })).control.holder).toBe("none");
  // The link minted before Give back is dead at the proxy (403 before any upstream call).
  const proxy = new Hono().all(
    "/computer-view/:token/*",
    createViewProxy({ secret: SECRET, now: h.deps.now }),
  );
  const res = await proxy.request(link.url);
  expect(res.status).toBe(403);
  // A link minted after the revoke (a later millisecond) is not refused.
  const now = h.deps.now;
  h.deps.now = () => now() + 1;
  await h.client.computer.takeControl({ botId: "a" });
  const fresh = await h.client.computer.view({ botId: "a", mode: "view" });
  expect((await proxy.request(fresh.url)).status).not.toBe(403);
});

test("closeView revokes earlier links, keeps the hold, and later links work", async () => {
  const h = setup();
  await h.client.computer.takeControl({ botId: "a" });
  const link = await h.client.computer.view({ botId: "a", mode: "view" });
  const proxy = new Hono().all(
    "/computer-view/:token/*",
    createViewProxy({ secret: SECRET, now: h.deps.now }),
  );
  expect(await h.client.computer.closeView({ botId: "a" })).toEqual({ ok: true });
  expect((await proxy.request(link.url)).status).toBe(403);
  expect((await h.client.computer.status({ botId: "a" })).control.holder).toBe("owner");
  const now = h.deps.now;
  h.deps.now = () => now() + 1;
  const later = await h.client.computer.view({ botId: "a", mode: "view" });
  expect((await proxy.request(later.url)).status).not.toBe(403);
});

test("a viewer url that does not parse is a readable CONFLICT", async () => {
  const h = setup();
  const provider = h.deps.computers?.provider;
  if (provider)
    provider.view = async () => ({ url: "not a url", port: 41000, expiresAt: 99_999_999 });
  await expect(h.client.computer.view({ botId: "a", mode: "view" })).rejects.toMatchObject({
    code: "CONFLICT",
  });
});
