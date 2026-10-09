import { expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { rollingFile } from "../src/observability/log-files";
import { createTaskHandler } from "../src/orchestrator/handle-task";
import { makeEnv, resultMsg, rolledFiles, TEST_CHANNEL } from "./helpers";

/** Permission bits (octal string) of a path. */
const mode = (p: string) => (statSync(p).mode & 0o777).toString(8);

test("dirs are 0700; db, sidecars, app log and per-task jsonl are 0600", async () => {
  const env = makeEnv();
  // A real run writes the db, the per-task jsonl and (via sqlite) the WAL/SHM files.
  const q = (_a: unknown) =>
    (async function* () {
      yield resultMsg();
    })();
  await createTaskHandler({ db: env.db, config: env.config, queryFn: q as never })({
    source: "t",
    channelId: TEST_CHANNEL,
    userId: "u",
    threadId: "th",
    text: "hi",
  });
  // The app logger is silent under test: open the rolling app log directly to check its mode.
  const sink = rollingFile(env.paths.appLog());
  sink.write('{"x":1}\n');
  await sink.ready();
  sink.end();

  const taskLog = env.db.query<{ id: string }, []>("SELECT id FROM tasks").get()!.id;
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
