import { expect, test } from "bun:test";
import { parseSlash } from "../src/commands/slash-commands";
import { parseMessageCommand } from "../src/orchestrator/message-commands";
import { isAdminText, parseAdminCommand } from "../src/providers/discord/setup/admin-command";

// Slash commands are the only commands: a plain text such as "stop" is an ordinary message.

test("parseSlash reads each command and leaves everything else alone", () => {
  expect(parseSlash("/stop")).toEqual({ name: "stop", arg: "" });
  expect(parseSlash("  /STATUS ")).toEqual({ name: "status", arg: "" });
  expect(parseSlash("/find invoice csv")).toEqual({ name: "find", arg: "invoice csv" });
  expect(parseSlash("/init-workspace shop")).toEqual({ name: "init-workspace", arg: "shop" });
  // no-argument commands given an argument are not commands
  for (const t of ["/stop now", "/status now", "/purge x"]) expect(parseSlash(t)).toBeNull();
  for (const t of ["stop", "hello /stop", "/unknown x", "/stopper", "see /stop", "http://x/stop"])
    expect(parseSlash(t)).toBeNull();
  // removed commands are plain text now
  expect(parseSlash("/cleanup abc123")).toBeNull();
});

test("task commands: only the slash forms are commands", () => {
  expect(parseMessageCommand("/stop")).toEqual({ kind: "stop" });
  expect(parseMessageCommand("/status")).toEqual({ kind: "status" });
  expect(parseMessageCommand("/purge")).toEqual({ kind: "purge" });
  expect(parseMessageCommand("/stop now")).toEqual({ kind: "message" });
  expect(parseMessageCommand("/go +2")).toEqual({ kind: "message" }); // /go is gone: plain text
  expect(parseMessageCommand("/cleanup t-1")).toEqual({ kind: "message" });
  // removed memory commands are plain messages for the lead
  for (const t of ["/remember x y z", "/forget global x y z", "/compact"])
    expect(parseMessageCommand(t)).toEqual({ kind: "message" });
  // text forms are plain messages for the lead
  for (const t of ["stop", "status", "purge", "forget: x y z", "compact memory", "remember: x y z"])
    expect(parseMessageCommand(t)).toEqual({ kind: "message" });
  // a plain message that only mentions a command is a task
  expect(parseMessageCommand("please /stop it")).toEqual({ kind: "message" });
});

test("admin command: /init-workspace only, in any place", () => {
  expect(isAdminText("/init-workspace shop")).toBe(true);
  expect(isAdminText("init:workspace:shop")).toBe(false);
  expect(isAdminText("/init-workspaces")).toBe(false);
  expect(parseAdminCommand("/init-workspace shop")).toEqual({
    kind: "init_workspace",
    name: "shop",
  });
  expect(parseAdminCommand("init:workspace:shop")).toMatchObject({ kind: "help" });
  expect(parseAdminCommand("/init-workspace Bad Name")).toMatchObject({ kind: "invalid_name" });
  expect(parseAdminCommand("/init-workspace")).toMatchObject({ kind: "invalid_name" });
});
