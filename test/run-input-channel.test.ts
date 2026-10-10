import { describe, expect, test } from "bun:test";
import { createInputChannel, MAX_PENDING_STEERS } from "../src/runtime/run-input-channel";

/** Content of the next item of the channel's iterable. */
const next = async (it: AsyncIterator<{ message: { content: unknown } }>) =>
  (await it.next()).value?.message.content;

describe("run input channel", () => {
  test("first item is the task prompt, steers follow in push order", async () => {
    const ch = createInputChannel("task");
    const it = ch.iterable[Symbol.asyncIterator]();
    expect(ch.push("one")).toBe("queued");
    expect(ch.push("two")).toBe("queued");
    expect(await next(it)).toBe("task");
    expect(await next(it)).toBe("one");
    expect(await next(it)).toBe("two");
  });

  test("a waiting consumer wakes on push", async () => {
    const ch = createInputChannel("task");
    const it = ch.iterable[Symbol.asyncIterator]();
    await next(it);
    const waiting = next(it); // queue empty: waits
    ch.push("late");
    expect(await waiting).toBe("late");
  });

  test("cap: the first prompt does not count; the next push after the cap is refused; pulling frees room", async () => {
    const ch = createInputChannel("task");
    const it = ch.iterable[Symbol.asyncIterator]();
    for (let n = 0; n < MAX_PENDING_STEERS; n++) expect(ch.push(`s${n}`)).toBe("queued");
    expect(ch.pending()).toBe(MAX_PENDING_STEERS);
    expect(ch.push("over")).toBe("full");
    await next(it); // the task prompt: still 5 steers pending
    expect(ch.push("over")).toBe("full");
    await next(it); // s0 pulled by the SDK
    expect(ch.pending()).toBe(MAX_PENDING_STEERS - 1);
    expect(ch.push("fits")).toBe("queued");
  });

  test("close() lets queued items drain, then ends; a push after it is kept as late (to resend in a resumed turn)", async () => {
    const ch = createInputChannel("task");
    const it = ch.iterable[Symbol.asyncIterator]();
    ch.push("kept");
    ch.close();
    expect(ch.push("late", "ref-1")).toBe("late");
    expect(ch.late()).toEqual([{ text: "late", ref: "ref-1" }]);
    expect(ch.unechoed().map((s) => s.text)).toEqual(["kept"]); // a late one never entered the input
    expect(await next(it)).toBe("task");
    expect(await next(it)).toBe("kept");
    expect((await it.next()).done).toBe(true);
  });

  test("after a hard close (stop, timeout, run end) a push is refused, not kept", () => {
    const ch = createInputChannel("task");
    ch.close(true);
    expect(ch.push("nobody reads this")).toBe("closed");
    expect(ch.late()).toEqual([]);
  });

  test("echo tracking: a pushed steer is delivered only when the CLI echoes its text back, in any order", () => {
    const ch = createInputChannel("task");
    ch.push("a", "r1");
    ch.push("b", "r2");
    ch.push("a", "r3"); // same text twice: each echo settles one
    expect(ch.unechoed().map((s) => s.ref)).toEqual(["r1", "r2", "r3"]);
    expect(ch.echoed("task")).toBeUndefined(); // the first prompt's echo is not a steer
    expect(ch.echoed("b")).toEqual({ text: "b", ref: "r2" });
    expect(ch.echoed("a")).toEqual({ text: "a", ref: "r1" });
    expect(ch.unechoed().map((s) => s.ref)).toEqual(["r3"]);
    expect(ch.echoed("nope")).toBeUndefined();
  });

  test("M-b echo match ignores whitespace (trim + collapse, both sides) (a re-wrapped echo is not a false 'not delivered')", () => {
    const ch = createInputChannel("task");
    ch.push("fix  the\n\nbug   in a.ts ", "r1");
    expect(ch.echoed("fix the bug in b.ts")).toBeUndefined(); // other words: no match
    expect(ch.echoed("  fix the bug in a.ts\n")).toEqual({
      text: "fix  the\n\nbug   in a.ts ",
      ref: "r1",
    });
    expect(ch.unechoed()).toEqual([]);
  });

  test("close(discard) drops everything queued and ends a waiting consumer", async () => {
    const ch = createInputChannel("task");
    const it = ch.iterable[Symbol.asyncIterator]();
    ch.push("dropped");
    ch.close(true);
    expect((await it.next()).done).toBe(true);
    const idle = createInputChannel("x");
    const it2 = idle.iterable[Symbol.asyncIterator]();
    await next(it2);
    const waiting = it2.next();
    idle.close(true);
    expect((await waiting).done).toBe(true);
  });
});
