import { expect, test } from "bun:test";
import { slashToLegacy } from "../src/commands/slash-commands";
import { isAdminText, parseAdminCommand } from "../src/discord-setup/admin-command";
import { parseMemoryCommand } from "../src/memory/memory-commands";
import { parseMessageCommand } from "../src/orchestrator/message-commands";

// L0: canonical slash forms and the legacy forms (still working this release) parse to the same commands.

test("slashToLegacy maps each canonical form and leaves everything else alone", () => {
  expect(slashToLegacy("/stop")).toBe("stop");
  expect(slashToLegacy("  /GO +1.5 ")).toBe("go +1.5");
  expect(slashToLegacy("/cleanup abc123")).toBe("/cleanup abc123"); // removed in Rev 15: plain text now
  // /remember maps to the plain `remember:` text, which no app parser takes (the agent gets it as a message)
  expect(slashToLegacy("/remember global tabs not spaces")).toBe(
    "remember: global tabs not spaces",
  );
  expect(slashToLegacy("/forget tabs")).toBe("forget: tabs");
  expect(slashToLegacy("/compact dry-run")).toBe("compact memory dry-run");
  expect(slashToLegacy("/init-workspace shop")).toBe("init:workspace:shop");
  // not commands (legacy parity: stop / go [+usd] / compact [dry-run] take nothing else): ORIGINAL text kept
  for (const t of ["/go to the store and fix x", "/stop now", "/go +abc", "/compact now"])
    expect(slashToLegacy(t)).toBe(t);
  expect(parseMessageCommand("/stop now")).toEqual({
    kind: "message",
    repo: undefined,
    text: "/stop now",
  });
  for (const t of ["stop", "hello /stop", "/unknown x", "/stopper", "see /go", "http://x/stop"])
    expect(slashToLegacy(t)).toBe(t);
});

test("task commands: slash and legacy forms parse the same", () => {
  const same: [string, string][] = [
    ["/stop", "stop"],
    ["/go", "go"],
    ["/go +2", "go +2"],
  ];
  for (const [slash, legacy] of same)
    expect(parseMessageCommand(slash)).toEqual(parseMessageCommand(legacy));
  expect(parseMessageCommand("/stop")).toEqual({ kind: "stop" });
  expect(parseMessageCommand("/go +2")).toEqual({ kind: "go", extraBudgetUsd: 2 });
  expect(parseMessageCommand("/cleanup t-1")).toMatchObject({ kind: "message" }); // no such command any more
  expect(parseMessageCommand("/forget global x y z")).toEqual({ kind: "memory" });
  expect(parseMessageCommand("/compact")).toEqual({ kind: "memory" });
  // legacy forms keep working
  expect(parseMessageCommand("stop")).toEqual({ kind: "stop" });
  expect(parseMessageCommand("forget: x y z")).toEqual({ kind: "memory" });
  expect(parseMessageCommand("remember: x y z")).toMatchObject({ kind: "message" }); // goes to the agent
  // a plain message that only mentions a command is a task
  expect(parseMessageCommand("please /stop it")).toMatchObject({ kind: "message" });
});

test("memory commands: slash and legacy forms are the same command", () => {
  expect(parseMemoryCommand("/forget global tabs not spaces")).toEqual(
    parseMemoryCommand("forget: global tabs not spaces"),
  );
  expect(parseMemoryCommand("/forget global tabs not spaces")).toMatchObject({
    kind: "forget",
    scope: { kind: "global" },
    needle: "tabs not spaces",
  });
  expect(parseMemoryCommand("/remember global tabs not spaces")).toBeNull();
  expect(parseMemoryCommand("/forget tabs")).toMatchObject({ kind: "forget", needle: "tabs" });
  expect(parseMemoryCommand("/compact dry-run")).toEqual({ kind: "compact", dryRun: true });
  expect(parseMemoryCommand("/compact")).toEqual({ kind: "compact", dryRun: false });
  expect(parseMemoryCommand("compact memory")).toEqual({ kind: "compact", dryRun: false });
  expect(parseMemoryCommand("/forget ab")).toMatchObject({ kind: "invalid" });
  expect(parseMemoryCommand("remember the milk is not a command")).toBeNull();
});

test("admin command: /init-workspace and init:workspace: are the same command, in any place", () => {
  expect(isAdminText("/init-workspace shop")).toBe(true);
  expect(isAdminText("init:workspace:shop")).toBe(true);
  expect(isAdminText("/init-workspaces")).toBe(false);
  expect(parseAdminCommand("/init-workspace shop")).toEqual({
    kind: "init_workspace",
    name: "shop",
  });
  expect(parseAdminCommand("init:workspace:shop")).toEqual({
    kind: "init_workspace",
    name: "shop",
  });
  expect(parseAdminCommand("/init-workspace Bad Name")).toMatchObject({ kind: "invalid_name" });
  expect(parseAdminCommand("/init-workspace")).toMatchObject({ kind: "invalid_name" });
});
