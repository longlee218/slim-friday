import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { channelMemoryFile } from "../src/memory/channel-memory";
import { buildPromptContext } from "../src/memory/prompt-context";
import { locationOfTool } from "../src/observability/tool-hooks";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { READ_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { CHANNEL_2, resultMsg, TEST_CHANNEL, twoWorkspaces } from "./helpers";
import { devLeadQuery, workersDone } from "./lead-harness";
import { STRAY_QUEUE_FILE, writeChannelNotes } from "./memory-fixture";

/** Full prompt context text of a worker run in channel `<ws>-agent` of `ws` (the lead's memory is in its user turn). */
const promptOf = (home: string, ws: string) =>
  buildPromptContext({
    agentHome: home,
    workspace: ws,
    channel: `${ws}-agent`,
    kind: "worker",
  }).join("\n\n");

test("same location name in two workspaces: lookups stay inside the workspace", () => {
  const { env, a, b, scan } = twoWorkspaces();
  const [w1, w2] = scan.workspaces;
  expect(w1!.locations[0]!.path).toBe(a);
  expect(w2!.locations[0]!.path).toBe(b);
  // tool-hooks attribution: a file of w1/api is not a location of w2.
  writeFileSync(join(a, "f.txt"), "x");
  writeFileSync(join(b, "f.txt"), "x");
  const read = (ws: string, file: string) =>
    locationOfTool(env.home, ws, READ_TOOL_NAME, { file_path: file });
  expect(read("w1", join(a, "f.txt"))).toBe("api");
  expect(read("w2", join(b, "f.txt"))).toBe("api");
  expect(read("w2", join(a, "f.txt"))).toBeUndefined();
  expect(read("w1", join(b, "f.txt"))).toBeUndefined();
});

test("same channel name pattern in two workspaces: memory writes and reads are per workspace", () => {
  const { env } = twoWorkspaces();
  writeChannelNotes(env.home, "w1", "w1-agent", ["W1_ONLY"]);
  expect(readFileSync(channelMemoryFile(env.home, "w1", "w1-agent"), "utf8")).toContain("W1_ONLY");
  writeChannelNotes(env.home, "w2", "w2-agent", ["W2_NOTE"]);
  expect(readFileSync(channelMemoryFile(env.home, "w2", "w2-agent"), "utf8")).not.toContain(
    "W1_ONLY",
  );
  expect(promptOf(env.home, "w1")).toContain("W1_ONLY");
  expect(promptOf(env.home, "w2")).not.toContain("W1_ONLY");
});

test("a stray pending queue file never reaches a prompt of any workspace; the owner's root memory does reach all", () => {
  const { env } = twoWorkspaces();
  const p = workspacePaths(env.home);
  writeFileSync(join(env.home, STRAY_QUEUE_FILE), "# pending\n\n## d\n- GLOBAL_MARK\n");
  for (const ws of ["w1", "w2"]) expect(promptOf(env.home, ws)).not.toContain("GLOBAL_MARK");
  // Owner promotion (by hand) is what makes it apply, and then to every workspace.
  writeFileSync(p.memory, "# global memory\n\n## promoted\n- GLOBAL_MARK\n");
  for (const ws of ["w1", "w2"]) expect(promptOf(env.home, ws)).toContain("GLOBAL_MARK");
});

test("a real dev run prompt contains no pending-file text and no other workspace's memory", async () => {
  const { env } = twoWorkspaces();
  writeFileSync(join(env.home, STRAY_QUEUE_FILE), "# pending\n\n## d\n- PENDING_MARK\n");
  writeChannelNotes(env.home, "w2", "w2-agent", ["W2_MARK"]);
  let prompt = "";
  const queryFn = (a: any) => {
    prompt = a.options.systemPrompt.append as string;
    return (async function* () {
      yield resultMsg();
    })();
  };
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
  expect(prompt).not.toContain("PENDING_MARK");
  expect(prompt).not.toContain("W2_MARK"); // TEST_CHANNEL routes to w1
});

test("a message from w2's channel gets w2's memory and not w1's", async () => {
  const { env } = twoWorkspaces();
  writeChannelNotes(env.home, "w1", "w1-agent", ["W1_MARK"]);
  writeChannelNotes(env.home, "w2", "w2-agent", ["W2_MARK"]);
  let prompt = "";
  const queryFn = (a: any) => {
    prompt = a.options.systemPrompt.append as string;
    return (async function* () {
      yield resultMsg();
    })();
  };
  const handle = createTurnHandler({
    db: env.db,
    config: env.config,
    queryFn: devLeadQuery(queryFn),
    leadTiming: { debounceMs: 10, announceWindowMs: 20 },
  });
  await handle({
    source: "t",
    channelId: CHANNEL_2,
    userId: "u",
    threadId: "th",
    text: "hello",
  });
  await workersDone(env.db);
  expect(prompt).toContain("W2_MARK");
  expect(prompt).not.toContain("W1_MARK");
});

test("no CLAUDE.md is created under the home by ensureHome or a handler run", async () => {
  const { env } = twoWorkspaces();
  const handle = createTurnHandler({
    db: env.db,
    config: env.config,
    queryFn: devLeadQuery((_a: unknown) =>
      (async function* () {
        yield resultMsg();
      })(),
    ),
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
  const found = readdirSync(env.home, { recursive: true, withFileTypes: true })
    .filter((e) => e.name === "CLAUDE.md" || e.name === "CLAUDE.local.md")
    .map((e) => join(e.parentPath, e.name));
  expect(found).toEqual([]);
  expect(existsSync(join(env.home, "workspaces", "w1", "cwd"))).toBe(true);
});

test("source has no legacyWorkspace, loadLocationRegistry or TODO(1b) leftovers", () => {
  const hits: string[] = [];
  for (const f of readdirSync(join(import.meta.dir, "..", "src"), {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!f.isFile() || !f.name.endsWith(".ts")) continue;
    const file = join(f.parentPath, f.name);
    if (/legacyWorkspace|loadLocationRegistry|TODO\(1b\)/.test(readFileSync(file, "utf8")))
      hits.push(file);
  }
  expect(hits).toEqual([]);
});
