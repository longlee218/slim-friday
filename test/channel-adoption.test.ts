import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { addWorkspaceChannel, createWorkspaceDir } from "../src/discord-setup/workspace-template";
import { type AdoptFacts, channelAdoptDecision } from "../src/ingress/channel-adoption";
import { renderUserNotice } from "../src/ingress/user-copy";
import { adoptChannel, slugChannelName, uniqueChannelName } from "../src/workspaces/adopt-channel";
import { assertTempHome } from "./helpers";

/** Facts of an adoptable message; each test breaks one. */
const OK: AdoptFacts = {
  ownerMention: true,
  guildOk: true,
  isText: true,
  isOps: false,
  mapped: false,
  spaceMatches: ["demo"],
  isPrivate: true,
};
const decide = (o: Partial<AdoptFacts>) => channelAdoptDecision({ ...OK, ...o });

test("decision: all gates ok -> adopt", () => {
  expect(decide({})).toEqual({ kind: "adopt", space: "demo" });
});

test("decision: every failed gate falls through (none)", () => {
  for (const o of [
    { ownerMention: false }, // stranger, no mention or slash text
    { guildOk: false },
    { isText: false }, // thread, forum, voice
    { isOps: true },
    { mapped: true },
    { spaceMatches: [] }, // not a space category / parent mismatch
  ])
    expect(decide(o)).toEqual({ kind: "none" });
});

test("decision: two spaces -> refuse ambiguous; not private -> refuse", () => {
  expect(decide({ spaceMatches: ["a", "b"] })).toEqual({ kind: "refuse", reason: "ambiguous" });
  expect(decide({ isPrivate: false })).toEqual({ kind: "refuse", reason: "not-private" });
});

test("slug and unique names", () => {
  expect(slugChannelName("Shop Front!")).toBe("shop-front");
  expect(slugChannelName("!!!")).toBe("");
  expect(slugChannelName("a".repeat(70))).toHaveLength(64);
  expect(uniqueChannelName(new Set(["shop-front"]), "shop-front")).toBe("shop-front-2");
  expect(uniqueChannelName(new Set(), "ops-control")).toBe("ops-control-2"); // reserved
  const all = new Set(["x", ...[2, 3, 4, 5, 6, 7, 8, 9].map((i) => `x-${i}`)]);
  expect(uniqueChannelName(all, "x")).toBeUndefined();
});

/** Temp home with space `demo` and its first channel. */
function home() {
  const h = mkdtempSync(join(tmpdir(), "friday-adopt-"));
  assertTempHome(h);
  createWorkspaceDir(h, "demo");
  addWorkspaceChannel(h, "demo", { id: "800000000000000002", name: "demo-agent", mode: "task" });
  return h;
}
const channelsOf = (h: string) =>
  (Bun.YAML.parse(readFileSync(workspacePaths(h).workspace("demo").config, "utf8")) as any)
    .channels;

test("adoptChannel writes {id,name,mode} with no locations key, once", () => {
  const h = home();
  const id = "800000000000000010";
  expect(adoptChannel(h, "demo", id, "Shop")).toEqual({ ok: true, name: "shop" });
  expect(channelsOf(h).at(-1)).toEqual({ id, name: "shop", mode: "task" });
  expect(adoptChannel(h, "demo", id, "Shop")).toEqual({ ok: false, reason: "already_mapped" });
  expect(channelsOf(h)).toHaveLength(2);
});

test("adoptChannel: slug collision and two simultaneous calls get distinct names", async () => {
  const h = home();
  const [a, b] = await Promise.all([
    Promise.resolve().then(() => adoptChannel(h, "demo", "800000000000000011", "Shop")),
    Promise.resolve().then(() => adoptChannel(h, "demo", "800000000000000012", "shop")),
  ]);
  expect([a, b].map((r) => (r.ok ? r.name : "")).sort()).toEqual(["shop", "shop-2"]);
  // Non-ASCII name: fallback slug from the id.
  expect(adoptChannel(h, "demo", "800000000000000013", "店舗🛒")).toEqual({
    ok: true,
    name: "channel-0013",
  });
});

test("notice copy exists in both languages", () => {
  const n = { kind: "channel-adopted", space: "demo", name: "shop" } as const;
  expect(renderUserNotice(n, "en")).toContain("Linked #shop to the demo space");
  expect(renderUserNotice(n, "vi")).toContain("#shop");
});

test("adoptChannel: all of -2..-9 taken -> no_free_name, yaml unchanged", () => {
  const h = home();
  adoptChannel(h, "demo", "800000000000000020", "x");
  for (let i = 2; i <= 9; i++) adoptChannel(h, "demo", `80000000000000003${i}`, "x");
  const before = readFileSync(workspacePaths(h).workspace("demo").config, "utf8");
  expect(adoptChannel(h, "demo", "800000000000000040", "x")).toEqual({
    ok: false,
    reason: "no_free_name",
  });
  expect(readFileSync(workspacePaths(h).workspace("demo").config, "utf8")).toBe(before);
});

test("adoptChannel: registry check fails (id also in another space) -> yaml restored, no memory dir", () => {
  const h = home();
  const id = "800000000000000050";
  createWorkspaceDir(h, "other");
  addWorkspaceChannel(h, "other", { id, name: "o", mode: "task" });
  const cfg = workspacePaths(h).workspace("demo").config;
  const before = readFileSync(cfg, "utf8");
  expect(adoptChannel(h, "demo", id, "shop")).toEqual({ ok: false, reason: "failed" });
  expect(readFileSync(cfg, "utf8")).toBe(before);
  expect(existsSync(workspacePaths(h).workspace("demo").channel("shop").root)).toBe(false);
});

test("adoptChannel: memory dir creation fails -> yaml restored, no mapping", () => {
  const h = home();
  const root = workspacePaths(h).workspace("demo").channel("shop").root;
  mkdirSync(dirname(root), { recursive: true });
  writeFileSync(root, "a file where the dir must go");
  const cfg = workspacePaths(h).workspace("demo").config;
  const before = readFileSync(cfg, "utf8");
  expect(adoptChannel(h, "demo", "800000000000000060", "shop")).toEqual({
    ok: false,
    reason: "failed",
  });
  expect(readFileSync(cfg, "utf8")).toBe(before);
});
