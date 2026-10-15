import { expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { rollingFile } from "../src/observability/log-files";
import { makeEnv, rolledFiles } from "./helpers";
import { leadHarness, until } from "./lead-harness";

/** Permission bits (octal string) of a path. */
const mode = (p: string) => (statSync(p).mode & 0o777).toString(8);

test("dirs are 0700; db, sidecars, app log and per-task jsonl are 0600", async () => {
  const env = makeEnv();
  // A real lead run writes the db, the per-task jsonl and (via sqlite) the WAL/SHM files.
  const h = leadHarness(() => "hi", env);
  await h.send("hi");
  await until(() => h.ofKind("lead").length > 0);
  await until(() => env.db.query("SELECT id FROM turns WHERE status != 'running'").get() !== null);
  // The app logger is silent under test: open the rolling app log directly to check its mode.
  const sink = rollingFile(env.paths.appLog());
  sink.write('{"x":1}\n');
  await sink.ready();
  sink.end();

  const taskLog = env.db.query<{ id: string }, []>("SELECT id FROM turns").get()!.id;
  const files = [
    env.paths.dbFile,
    `${env.paths.dbFile}-wal`,
    `${env.paths.dbFile}-shm`,
    ...rolledFiles(env.paths.appLog()),
    env.paths.taskLog(taskLog),
  ];
  for (const f of files.filter(existsSync)) expect([f, mode(f)]).toEqual([f, "600"]);
  expect(existsSync(env.paths.dbFile)).toBe(true);
  expect(existsSync(env.paths.taskLog(taskLog))).toBe(true);
  for (const d of [
    dirname(env.paths.dbFile),
    dirname(env.paths.appLog()),
    dirname(env.paths.taskLog(taskLog)),
  ]) {
    expect([d, mode(d)]).toEqual([d, "700"]);
  }
});
