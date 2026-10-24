import { expect, test } from "bun:test";
import type { FridayEvent } from "@friday/contracts";
import { EventBus } from "../src/event-bus";

const ev: FridayEvent = { type: "config.changed" };

/** Take the first n items of an async iterable. */
async function firstN<T>(it: AsyncIterable<T>, n: number): Promise<T[]> {
  const out: T[] = [];
  if (n === 0) return out;
  for await (const x of it) {
    out.push(x);
    if (out.length >= n) break;
  }
  return out;
}

test("replays from a held id, resyncs from a lost or future id", async () => {
  const bus = new EventBus(3);
  const sig = new AbortController().signal;
  for (let i = 0; i < 5; i++) bus.publish(ev); // ids 1..5, holds 3..5
  expect(bus.lastId()).toBe(5);
  expect(await firstN(bus.subscribe(3, sig), 2)).toEqual([
    { id: 4, event: ev },
    { id: 5, event: ev },
  ]);
  expect(await firstN(bus.subscribe(2, sig), 1)).toEqual([{ id: 3, event: ev }]);
  expect((await firstN(bus.subscribe(1, sig), 1))[0]?.event).toEqual({ type: "resync" });
  expect((await firstN(bus.subscribe(99, sig), 1))[0]).toEqual({
    id: 5,
    event: { type: "resync" },
  });
});

test("no id: live only; id equal to lastId replays nothing", async () => {
  const bus = new EventBus(3);
  bus.publish(ev);
  const sig = new AbortController().signal;
  const live = firstN(bus.subscribe(undefined, sig), 1);
  const caught = firstN(bus.subscribe(1, sig), 1);
  expect(bus.publish(ev)).toBe(2);
  expect(await live).toEqual([{ id: 2, event: ev }]);
  expect(await caught).toEqual([{ id: 2, event: ev }]);
});

test("live events reach every subscriber in order; abort ends the iterator", async () => {
  const bus = new EventBus();
  const ac = new AbortController();
  const a = firstN(bus.subscribe(undefined, ac.signal), 3);
  const b = firstN(bus.subscribe(undefined, ac.signal), 3);
  for (let i = 0; i < 3; i++) bus.publish(ev);
  const want = [1, 2, 3];
  expect((await a).map((x) => x.id)).toEqual(want);
  expect((await b).map((x) => x.id)).toEqual(want);

  const ended = (async () => {
    const got: number[] = [];
    for await (const x of bus.subscribe(undefined, ac.signal)) got.push(x.id);
    return got;
  })();
  ac.abort();
  expect(await ended).toEqual([]);
  // an already-aborted signal ends at once
  expect(await firstN(bus.subscribe(undefined, ac.signal), 1)).toEqual([]);
});

test("a subscriber `size` events behind gets resync and ends", async () => {
  const bus = new EventBus(3);
  const sig = new AbortController().signal;
  const it = bus.subscribe(undefined, sig);
  for (let i = 0; i < 4; i++) bus.publish(ev); // nothing read: the 3rd undelivered event trips it
  const got: unknown[] = [];
  for await (const x of it) got.push(x); // ends without abort
  expect(got).toEqual([{ id: 3, event: { type: "resync" } }]);
});
