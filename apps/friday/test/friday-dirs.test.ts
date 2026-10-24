import { expect, test } from "bun:test";
import type { Bot } from "@friday/core";
import { fridayExtraDirs } from "../src/friday-bot";

const bot = (id: string) => ({ id }) as Bot;

test("only the Friday bot gets dirs: write on bots and groups (not settings), read on templates", () => {
  const f = fridayExtraDirs("/h/config", "/repo/templates");
  expect(f(bot("friday"))).toEqual({
    write: ["/h/config/bots", "/h/config/groups"],
    read: ["/repo/templates"],
  });
  expect(f(bot("ann"))).toEqual({ write: [], read: [] });
});
