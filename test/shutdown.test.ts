import { expect, test } from "bun:test";
import { createShutdown } from "../src/lifecycle/shutdown";

test("shutdown drains before closing db, and is re-entrant safe", async () => {
  const order: string[] = [];
  const shutdown = createShutdown({
    drain: async () => {
      await Bun.sleep(20);
      order.push("drain");
    },
    destroyClient: async () => {
      order.push("client");
    },
    closeDb: () => {
      order.push("db");
    },
    log: () => {},
    exit: (c) => {
      order.push(`exit${c}`);
    },
  });
  await Promise.all([shutdown("SIGINT"), shutdown("SIGINT"), shutdown("SIGTERM")]);
  expect(order).toEqual(["drain", "client", "db", "exit0"]);
});

test("a failing step does not skip db close; exit code propagates", async () => {
  const order: string[] = [];
  const shutdown = createShutdown({
    drain: async () => {
      throw new Error("x");
    },
    destroyClient: async () => {
      throw new Error("y");
    },
    closeDb: () => {
      order.push("db");
    },
    log: () => {},
    exit: (c) => {
      order.push(`exit${c}`);
    },
  });
  await shutdown("uncaughtException", 1);
  expect(order).toEqual(["db", "exit1"]);
});
