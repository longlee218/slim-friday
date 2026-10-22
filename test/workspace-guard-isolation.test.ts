import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { guardFor } from "../src/policy/check-tool-call";
import { getRole } from "../src/roles/role-registry";
import { buildToolPermissions } from "../src/runtime/tool-permissions";
import {
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  READ_TOOL_NAME,
  WRITE_TOOL_NAME,
} from "../src/tools/sdk-tool-names";
import { resultMsg, TEST_CHANNEL, twoWorkspaces } from "./helpers";
import { devLeadQuery, workersDone } from "./lead-harness";

/** Isolation cases: a w1 run (real guard, fake query) must be denied every reach into w2 or the home data. */
test("w1 run cannot reach w2 clone, w2 scratch, git path, symlink escape or agent.db", async () => {
  const { env, a, b } = twoWorkspaces();
  writeFileSync(join(b, "secret.txt"), "W2_SECRET");
  writeFileSync(join(a, "own.txt"), "mine");
  symlinkSync(join(b, "secret.txt"), join(a, "link.txt")); // symlink inside w1's location into w2
  const w2wt = workspacePaths(env.home).run("t1");
  mkdirSync(w2wt, { recursive: true });
  type Can = (t: string, i: Record<string, unknown>, o: unknown) => Promise<{ behavior: string }>;
  let can: Can | undefined;
  const queryFn = (x: any) => {
    can = x.options.canUseTool;
    return (async function* () {
      yield resultMsg();
    })();
  };
  // A message the fake lead dispatches to a dev worker (detached): its canUseTool is the run's real permission layer.
  const handle = createTurnHandler({
    db: env.db,
    config: env.config,
    queryFn: devLeadQuery(queryFn),
    leadTiming: { debounceMs: 10, announceWindowMs: 20 },
  });
  await handle({
    source: "t",
    channelId: TEST_CHANNEL,
    userId: "u",
    threadId: "th",
    text: "hello",
  });
  await workersDone(env.db);
  const qa = can!;
  // Exec-stage guard of a w1 task: it may write only its own scratch dir.
  const w1wt = workspacePaths(env.home).run("t0");
  mkdirSync(w1wt, { recursive: true });
  const exec = buildToolPermissions({
    turnId: "t",
    threadId: "th",
    guard: guardFor(getRole("developer"), { writePaths: [w1wt], readPaths: [w1wt] }),
  }).canUseTool as unknown as Can;
  const db = workspacePaths(env.home).dbFile;
  const cases: [string, () => Promise<{ behavior: string }>][] = [
    ["Read w2 clone", () => qa(READ_TOOL_NAME, { file_path: join(b, "secret.txt") }, {})],
    ["Glob w2 clone", () => qa(GLOB_TOOL_NAME, { pattern: "*", path: b }, {})],
    ["Grep w2 clone", () => qa(GREP_TOOL_NAME, { pattern: "x", path: b }, {})],
    ["Read via symlink", () => qa(READ_TOOL_NAME, { file_path: join(a, "link.txt") }, {})],
    ["Read agent.db", () => qa(READ_TOOL_NAME, { file_path: db }, {})],
    [
      "Write w2 scratch",
      () => exec(WRITE_TOOL_NAME, { file_path: join(w2wt, "f.txt"), content: "x" }, {}),
    ],
  ];
  for (const [name, call] of cases) expect([name, (await call()).behavior]).toEqual([name, "deny"]);
  // Control: the run's own location is readable.
  expect((await qa(READ_TOOL_NAME, { file_path: join(a, "own.txt") }, {})).behavior).toBe("allow");
});
