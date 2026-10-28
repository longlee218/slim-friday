import { expect, test } from "bun:test";
import type { Bot } from "@friday/core";
import { CDP_PORT_RANGE, cdpPortOf, fnv1a32 } from "../src/computer-ports";

const bot = (id: string, computer?: string): Bot => ({
  id,
  name: id,
  title: "",
  instructions: "",
  model: "m",
  tools: [],
  skills: [],
  subagents: [],
  workspaces: [],
  ...(computer && { computer }),
});
const home = (...ids: string[]) => ids.map((id) => bot(id, "home"));
const preferred = (id: string) => 9300 + (fnv1a32(id) % CDP_PORT_RANGE);

/** An id whose preferred port equals `id`'s (a forced hash collision). */
function collidingWith(id: string): string {
  for (let i = 0; ; i++) {
    const other = `b${i}`;
    if (other !== id && preferred(other) === preferred(id)) return other;
  }
}

test("fnv1a32 matches the reference values", () => {
  expect(fnv1a32("")).toBe(0x811c9dc5);
  expect(fnv1a32("a")).toBe(0xe40c292c);
  expect(fnv1a32("foobar")).toBe(0xbf9cf968);
});

test("a bot's port comes from its id, stays in 9300..9999 and is distinct per computer", () => {
  const bots = [...home("ann", "bob"), bot("carl", "work"), bot("dan")];
  const ann = cdpPortOf("ann", "home", bots);
  const bob = cdpPortOf("bob", "home", bots);
  expect(ann).toBe(preferred("ann"));
  expect(ann).not.toBe(bob);
  for (const p of [ann, bob]) expect(p >= 9300 && p < 10_000).toBe(true);
  expect(cdpPortOf("carl", "work", bots)).toBe(preferred("carl"));
});

test("adding a bot (even one that sorts first) does not move the existing bots", () => {
  const before = home("bob", "carl");
  const after = home("aaa", "bob", "carl");
  for (const id of ["bob", "carl"])
    expect(cdpPortOf(id, "home", after)).toBe(cdpPortOf(id, "home", before));
});

test("a hash collision shifts the later id (sorted) to the next free port and is reported", () => {
  const other = collidingWith("ann");
  const [first, second] = ["ann", other].sort() as [string, string];
  const shifts: string[] = [];
  const bots = home(other, "ann");
  const onShift = (moved: string, taken: string) => shifts.push(`${moved}<-${taken}`);
  expect(cdpPortOf(first, "home", bots, onShift)).toBe(preferred(first));
  expect(cdpPortOf(second, "home", bots, onShift)).toBe(preferred(first) + 1);
  expect(shifts).toContain(`${second}<-${first}`);
});

test("probing wraps from the top of the range back to 9300", () => {
  let top = "";
  for (let i = 0; !top; i++) if (preferred(`t${i}`) === 9999) top = `t${i}`;
  const clash = collidingWith(top);
  const [first, second] = [top, clash].sort() as [string, string];
  const bots = home(first, second);
  expect(cdpPortOf(first, "home", bots)).toBe(9999);
  expect(cdpPortOf(second, "home", bots)).toBe(9300);
});
