import { expect, test } from "bun:test";
import { openDb } from "../src/storage/db";
import { teammateByName } from "../src/storage/teammate-store";
import {
  archiveTeammateByName,
  createTeammate,
  editTeammate,
  listTeammates,
  TeammateAdminError,
} from "../src/teammates/teammate-admin";
import { parseTeammateCommand } from "../src/teammates/teammate-command";

/* The /teammate core with a fake channel callback: checks before side effects, row values, edit validation. */

function setup() {
  const db = openDb(":memory:");
  const made: string[] = [];
  const deps = {
    db,
    createPrivateChannel: async (s: { space: string; name: string }) => {
      made.push(`${s.space}/${s.name}`);
      return { channelId: `chan-${s.name}` };
    },
  };
  return { db, deps, made };
}

test("create: channel made, row inserted with the preset's values and the typed model alias", async () => {
  const { deps, made, db } = setup();
  const r = await createTeammate(deps, { space: "work", name: "ops-bot", model: "haiku" });
  expect(made).toEqual(["work/ops-bot"]);
  expect(r.channelId).toBe("chan-ops-bot");
  expect(teammateByName(db, "ops-bot")).toMatchObject({
    channelId: "chan-ops-bot",
    preset: "chief-of-staff",
    model: "claude-haiku-5-5",
  });
});

test("create: bad name, duplicate, unknown preset or model are refused BEFORE the channel is made", async () => {
  const { deps, made } = setup();
  await createTeammate(deps, { space: "work", name: "alpha" });
  made.length = 0;
  for (const bad of [
    { name: "A" },
    { name: "alpha" },
    { name: "beta", preset: "nope" },
    { name: "beta", model: "gpt-9" },
  ])
    await expect(createTeammate(deps, { space: "work", ...bad })).rejects.toBeInstanceOf(
      TeammateAdminError,
    );
  expect(made).toEqual([]);
});

test("edit: text fields and tool lists change; a tool no teammate may hold is refused naming it", async () => {
  const { deps } = setup();
  await createTeammate(deps, { space: "work", name: "alpha" });
  const t = editTeammate(deps, "alpha", { title: "Ops", instructions: "Be brief.", model: "opus" });
  expect(t).toMatchObject({ title: "Ops", instructions: "Be brief.", model: "claude-opus-5-5" });
  expect(() => editTeammate(deps, "alpha", { tools: ["Report"] })).toThrow("Report");
  expect(() => editTeammate(deps, "alpha", { tools: ["NoSuchTool"] })).toThrow("NoSuchTool");
  expect(() => editTeammate(deps, "ghost", { title: "x" })).toThrow("No active teammate");
});

test("archive hides it from list; archiving twice is refused", async () => {
  const { deps } = setup();
  await createTeammate(deps, { space: "work", name: "alpha" });
  archiveTeammateByName(deps, "alpha");
  expect(listTeammates(deps)).toEqual([]);
  expect(() => archiveTeammateByName(deps, "alpha")).toThrow(TeammateAdminError);
});

test("parse: the four verbs, the rest-of-line value, comma lists; anything else is undefined", () => {
  expect(parseTeammateCommand("create work ops-bot sonnet")).toEqual({
    kind: "create",
    space: "work",
    name: "ops-bot",
    model: "sonnet",
  });
  expect(parseTeammateCommand("list")).toEqual({ kind: "list" });
  expect(parseTeammateCommand("archive alpha")).toEqual({ kind: "archive", name: "alpha" });
  expect(parseTeammateCommand("edit alpha instructions Always  reply in Vietnamese.")).toEqual({
    kind: "edit",
    name: "alpha",
    edit: { instructions: "Always  reply in Vietnamese." },
  });
  expect(parseTeammateCommand("edit alpha tools read, web ,TaskBoard")).toEqual({
    kind: "edit",
    name: "alpha",
    edit: { tools: ["read", "web", "TaskBoard"] },
  });
  for (const bad of ["", "create work", "edit alpha color red", "edit alpha title", "list x"])
    expect(parseTeammateCommand(bad)).toBeUndefined();
});

/* The Discord glue: reply text for each command, no Discord needed before the channel step. */
import { runTeammateCommand } from "../src/providers/discord/setup/teammate-command-run";

test("runTeammateCommand: usage for junk, empty list, refusals before any channel is made", async () => {
  const { db } = setup();
  const init = { home: "/nonexistent", guild: {} as never, ids: {} as never };
  expect(await runTeammateCommand(db, init, "nonsense")).toContain("Usage:");
  expect(await runTeammateCommand(db, init, "list")).toContain("No teammates yet");
  expect(await runTeammateCommand(db, init, "create work BAD_NAME")).toContain("2-32 characters");
  expect(await runTeammateCommand(db, init, "archive ghost")).toContain("No active teammate");
  expect(await runTeammateCommand(db, init, "edit ghost title x")).toContain("No active teammate");
});
