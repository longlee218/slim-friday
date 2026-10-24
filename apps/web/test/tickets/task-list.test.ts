import { describe, expect, test } from "vitest";
import { taskProgress, toggleTask } from "../../src/components/tickets/task-list";

const md = "- [x] a\n```\n- [ ] code\n```\n- [ ] b";

describe("task list", () => {
  test("taskProgress ignores tasks inside fenced code", () => {
    expect(taskProgress(md)).toEqual({ done: 1, all: 2 });
  });
  test("taskProgress handles ~~~ fences, other bullets and X", () => {
    expect(taskProgress("~~~\n- [ ] x\n~~~\n* [X] a\n  + [ ] b")).toEqual({ done: 1, all: 2 });
  });
  test("toggleTask flips only the nth real task", () => {
    expect(toggleTask(md, 1)).toBe("- [x] a\n```\n- [ ] code\n```\n- [x] b");
    expect(toggleTask(md, 0)).toBe("- [ ] a\n```\n- [ ] code\n```\n- [ ] b");
  });
  test("toggleTask leaves the text alone for an unknown index", () => {
    expect(toggleTask(md, 5)).toBe(md);
  });
});
