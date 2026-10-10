import { describe, expect, test } from "bun:test";
import {
  EFFORT_FLOOR_DECAY_TURNS,
  EffortFloors,
  resolveEffort,
} from "../src/orchestrator/thread/effort-floor";

describe("resolveEffort", () => {
  test("base from class, turn delta, minimum", () => {
    expect(resolveEffort({}).final).toBe("medium");
    expect(resolveEffort({ cls: "mechanical" }).final).toBe("low");
    expect(resolveEffort({ cls: "design" }).final).toBe("high");
    expect(resolveEffort({ turnDelta: 1 }).final).toBe("high");
    expect(resolveEffort({ turnDelta: -1 }).final).toBe("low");
    expect(resolveEffort({ cls: "mechanical", minimum: "high" }).final).toBe("high");
  });
  test("precedence: explicit > floor > traits", () => {
    expect(resolveEffort({ cls: "mechanical", floor: "high" }).final).toBe("high");
    expect(resolveEffort({ cls: "design", floor: "high", explicit: "low" }).final).toBe("low");
  });
  test("max needs confirmation: capped at high and flagged until confirmed", () => {
    expect(resolveEffort({ explicit: "max" })).toEqual({ final: "high", pendingMax: true });
    expect(resolveEffort({ explicit: "max", maxConfirmed: true })).toEqual({
      final: "max",
      pendingMax: false,
    });
    expect(resolveEffort({ cls: "design", turnDelta: 1 }).pendingMax).toBe(true);
  });
});

describe("EffortFloors", () => {
  test("decay constant is 3", () => expect(EFFORT_FLOOR_DECAY_TURNS).toBe(3));
  test("complaint raises one above the used effort; capped at high", () => {
    const f = new EffortFloors();
    f.raise("t", "low");
    expect(f.get("t")).toBe("medium");
    f.raise("t", "medium"); // already floor medium, used medium: +1
    expect(f.get("t")).toBe("high");
    f.raise("t", "high");
    expect(f.get("t")).toBe("high");
    expect(f.get("other")).toBeUndefined();
  });
  test("drops one level after an accepted result", () => {
    const f = new EffortFloors();
    f.raise("t", "medium"); // high
    f.accepted("t");
    expect(f.get("t")).toBe("medium");
    f.accepted("t");
    expect(f.get("t")).toBeUndefined();
  });
  test("drops one level after 3 quiet turns, counter restarts", () => {
    const f = new EffortFloors();
    f.raise("t", "medium"); // high
    f.quietTurn("t");
    f.quietTurn("t");
    expect(f.get("t")).toBe("high");
    f.quietTurn("t");
    expect(f.get("t")).toBe("medium");
    f.quietTurn("t");
    f.quietTurn("t");
    expect(f.get("t")).toBe("medium");
    f.quietTurn("t");
    expect(f.get("t")).toBeUndefined();
  });
  test("a complaint resets the quiet counter", () => {
    const f = new EffortFloors();
    f.raise("t", "medium");
    f.quietTurn("t");
    f.quietTurn("t");
    f.raise("t", "high");
    f.quietTurn("t");
    f.quietTurn("t");
    expect(f.get("t")).toBe("high");
  });
  test("threads are independent", () => {
    const f = new EffortFloors();
    f.raise("a", "medium");
    expect(f.get("b")).toBeUndefined();
  });
});
