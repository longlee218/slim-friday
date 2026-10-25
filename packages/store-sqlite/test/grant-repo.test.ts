import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, type Grant } from "@friday/core";
import { openEngineStore } from "../src/engine-store";

const MIGRATIONS = join(import.meta.dir, "../src/migrations");

/** A rule with defaults. */
const rule = (over: Partial<Grant>): Grant => ({
  id: "r1",
  botId: "*",
  effect: "always_allow",
  match: "tool",
  tool: "T",
  scope: {},
  createdAt: 1,
  ...over,
});

test("rules round-trip with effect and match; all lists every bot oldest first; revoke deletes", async () => {
  const s = openEngineStore(":memory:");
  const site = rule({ id: "s", match: "site", tool: "example.com", botId: "b1", createdAt: 2 });
  const req = rule({
    id: "c",
    match: "category",
    tool: "email",
    effect: "require_approval",
    botId: "b2",
    createdAt: 3,
  });
  const tool = rule({ id: "t", scope: { repo: "a" }, createdAt: 1 });
  for (const g of [site, req, tool]) await s.grants.add(g);
  expect(await s.grants.all()).toEqual([tool, site, req]);
  expect((await s.grants.list("b1")).map((g) => g.id).sort()).toEqual(["s", "t"]);
  await s.grants.revoke("s");
  expect((await s.grants.all()).map((g) => g.id)).toEqual(["t", "c"]);
});

test("a grant stored before the rules migration is an always_allow tool rule after it and still allows", async () => {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta/_journal.json"), "utf8"))
    .entries as {
    when: number;
    tag: string;
  }[];
  const f = join(mkdtempSync(join(tmpdir(), "grant-db-")), "sub", "engine.db");
  mkdirSync(join(f, ".."), { recursive: true });
  const raw = new Database(f, { create: true });
  // Build the db as it was before 0012: every earlier migration applied and logged, as drizzle does.
  const old = journal.filter((e) => e.tag < "0012");
  for (const e of old)
    for (const stmt of readFileSync(join(MIGRATIONS, `${e.tag}.sql`), "utf8").split(
      "--> statement-breakpoint",
    ))
      raw.run(stmt);
  raw.run(
    "CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC)",
  );
  for (const e of old) {
    const hash = new Bun.CryptoHasher("sha256")
      .update(readFileSync(join(MIGRATIONS, `${e.tag}.sql`), "utf8"))
      .digest("hex");
    raw.run("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)", [hash, e.when]);
  }
  raw.run(
    `INSERT INTO grants (id, bot_id, tool, scope, created_at) VALUES ('g-old', 'b1', 'Push', '{"repo":"a"}', 5)`,
  );
  raw.close();

  const s = openEngineStore(f);
  const grants = await s.grants.list("b1");
  expect(grants).toEqual([
    {
      id: "g-old",
      botId: "b1",
      effect: "always_allow",
      match: "tool",
      tool: "Push",
      scope: { repo: "a" },
      createdAt: 5,
    },
  ]);
  const spec = {
    name: "Push",
    annotations: { destructiveHint: false, openWorldHint: true },
    scopeKeys: ["repo"],
  };
  const call = { botId: "b1", conversationId: "c", tool: "Push", input: { repo: "a" } };
  expect(decide({ call, spec, grants, settings: { level: "balanced" }, now: 10 })).toMatchObject({
    outcome: "allow",
    reason: "rule g-old",
  });
});
