import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { openEngineStore } from "../src/engine-store";
import { openEngineDb } from "../src/open-engine-db";
import { sessionRepo } from "../src/repos/session-repo";

test("stateSet then stateGet returns the hashes", async () => {
  const s = openEngineStore(":memory:");
  await s.sessions.set("ann", "s1");
  await s.sessions.stateSet("ann", { rules: "r1", memory: "m1" });
  expect(await s.sessions.stateGet("ann")).toEqual({ rules: "r1", memory: "m1" });
});

test("stateGet is undefined before any stateSet", async () => {
  const s = openEngineStore(":memory:");
  await s.sessions.set("ann", "s1");
  expect(await s.sessions.stateGet("ann")).toBeUndefined();
});

test("set with a new session id drops the hashes", async () => {
  const s = openEngineStore(":memory:");
  await s.sessions.set("ann", "s1");
  await s.sessions.stateSet("ann", { rules: "r1" });
  await s.sessions.set("ann", "s2");
  expect(await s.sessions.get("ann")).toBe("s2");
  expect(await s.sessions.stateGet("ann")).toBeUndefined();
});

test("set with the same id keeps them", async () => {
  const s = openEngineStore(":memory:");
  await s.sessions.set("ann", "s1");
  await s.sessions.stateSet("ann", { rules: "r1" });
  await s.sessions.set("ann", "s1");
  expect(await s.sessions.stateGet("ann")).toEqual({ rules: "r1" });
});

test("clearing a session drops its hashes", async () => {
  const s = openEngineStore(":memory:");
  await s.sessions.set("ann", "s1");
  await s.sessions.stateSet("ann", { rules: "r1" });
  await s.sessions.clear("ann");
  await s.sessions.set("ann", "s1");
  expect(await s.sessions.stateGet("ann")).toBeUndefined();

  await s.sessions.set("ann@g1", "s2");
  await s.sessions.stateSet("ann@g1", { memory: "m" });
  await s.sessions.clearBot("ann");
  await s.sessions.set("ann@g1", "s2");
  expect(await s.sessions.stateGet("ann@g1")).toBeUndefined();

  await s.sessions.stateSet("ann@g1", { memory: "m" });
  await s.sessions.clearGroup("g1");
  await s.sessions.set("ann@g1", "s2");
  expect(await s.sessions.stateGet("ann@g1")).toBeUndefined();
});

test("stateSet without a row does nothing", async () => {
  const s = openEngineStore(":memory:");
  await s.sessions.stateSet("ghost", { rules: "r1" });
  expect(await s.sessions.get("ghost")).toBeUndefined();
  expect(await s.sessions.stateGet("ghost")).toBeUndefined();
  await s.sessions.set("ghost", "s1");
  expect(await s.sessions.stateGet("ghost")).toBeUndefined();
});

test("stateGet is undefined for a stored value that is not a JSON object", async () => {
  const db = openEngineDb(":memory:");
  const sessions = sessionRepo(drizzle({ client: db }));
  await sessions.set("ann", "s1");
  for (const bad of ["{not json", "[1,2]", "null", '"text"', "7"]) {
    db.run("UPDATE sessions SET state_hashes = ? WHERE bot_id = 'ann'", [bad]);
    expect(await sessions.stateGet("ann")).toBeUndefined();
  }
});
