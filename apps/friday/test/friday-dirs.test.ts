import { expect, test } from "bun:test";
import type { Bot } from "@friday/core";
import { fridayExtraDirs } from "../src/friday-bot";

const bot = (id: string) => ({ id }) as Bot;

test("only the Friday bot gets a dir, and only to read the templates: it writes the config through BotDesign", () => {
  const f = fridayExtraDirs("/repo/templates");
  expect(f(bot("friday"))).toEqual({ write: [], read: ["/repo/templates"] });
  expect(f(bot("ann"))).toEqual({ write: [], read: [] });
});
