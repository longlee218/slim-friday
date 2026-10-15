import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createAdminHandler } from "../src/discord-setup/admin-handler";
import {
  CONTROL_SESSION_MAX_AGE_MS,
  createControlRoleRun,
} from "../src/discord-setup/control-role-run";
import { privateOverwrites } from "../src/discord-setup/private-channels";
import { postResumeNotices } from "../src/lifecycle/resume-interrupted";
import { DISCORD_ADMIN_MCP_SERVER } from "../src/mcp/mcp-tool-names";
import {
  insertTurn,
  interruptRunningTurns,
  listInterruptedThreads,
} from "../src/storage/run-store";
import { getSession } from "../src/storage/session-store";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  BASH_TOOL_NAME,
  WRITE_TOOL_NAME,
} from "../src/tools/sdk-tool-names";
import { fakeGuild } from "./fake-guild";
import { initMsg, makeEnv, resultMsg, stubGateway } from "./helpers";

const ids = { guildId: "G1", ownerId: "OWN", botId: "BOT" };
const CTRL = "CTRL";

/** A control-channel message: private channel, records everything the bot sends there. */
function control(guild: unknown) {
  const sent: string[] = [];
  const cache = privateOverwrites(ids).map((o) => ({
    id: o.id,
    type: o.type,
    allow: { bitfield: o.allow },
    deny: { bitfield: o.deny },
  }));
  const channel: any = {
    id: CTRL,
    isThread: () => false,
    isSendable: () => true,
    sendTyping: async () => {},
    permissionOverwrites: { cache: { values: () => cache.values() } },
    send: async (x: string | { content?: string }) =>
      void sent.push(typeof x === "string" ? x : (x.content ?? "")),
  };
  const msg = () => ({
    guild,
    guildId: "G1",
    channel,
    reply: async (o: any) => void sent.push(o.content),
  });
  return { sent, msg };
}

const CONTENT = "# Soul\n- Patient.\n- Short steps.\n";

/** Whole setup: env, fake guild, gateway that records asks/confirms, admin handler wired to the control runner. */
function setup(over: { approve?: boolean; queryFn?: any; approvals?: any } = {}) {
  const env = makeEnv({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test" });
  const g = fakeGuild([]);
  const c = control(g.guild);
  const log: { asks: any[]; confirms: any[] } = { asks: [], confirms: [] };
  const approvals =
    over.approvals ??
    stubGateway({
      askChoice: async (a) => {
        log.asks.push(a);
        return a.options[0];
      },
      confirm: async (req) => {
        log.confirms.push(req);
        return { approved: over.approve ?? true };
      },
    });
  const queries: any[] = [];
  const queryFn =
    over.queryFn ??
    ((a: any) => {
      queries.push(a);
      return script(a);
    });
  const run = createControlRoleRun({ db: env.db, config: env.config, approvals, queryFn });
  const handle = createAdminHandler({
    home: env.home,
    guildId: "G1",
    ownerId: "OWN",
    botId: () => "BOT",
    setup: { controlChannels: [CTRL], ops: {} } as any,
    controlRun: run,
  });
  return { env, g, c, log, queries, handle };
}

/** The fake agent: asks, lists, creates a space, writes its SOUL.md (diff + confirm), then answers. */
async function* script(a: any) {
  const o = a.options;
  yield { ...initMsg, session_id: "sess-ctl", cwd: o.cwd } as never;
  const ans = await o.canUseTool(
    ASK_USER_QUESTION_TOOL_NAME,
    {
      questions: [
        { question: "Create study space english?", options: [{ label: "Yes" }, { label: "No" }] },
      ],
    },
    {},
  );
  if (ans.behavior !== "allow") throw new Error("ask denied");
  const tools = o.mcpServers[DISCORD_ADMIN_MCP_SERVER].instance._registeredTools;
  const text = async (name: string, args: object) =>
    (await tools[name].handler(args, {})).content[0].text as string;
  await text("ListSpaces", {});
  const made = await text("CreateSpaceOrChannel", { space: "english" });
  const wrote = await text("WriteSpaceFile", {
    space: "english",
    file: "SOUL.md",
    content: CONTENT,
  });
  yield resultMsg({
    result: `${made.slice(0, 20)} | ${wrote}`,
    session_id: "sess-ctl",
    total_cost_usd: 0.01,
  });
}

test("end to end: owner text in #ops-control runs the role with no workspace; ask, create and write go through the tools", async () => {
  const s = setup();
  await s.handle(s.c.msg() as any, "make a study space called english");
  const o = s.queries[0].options;
  // No workspace: control dir, only the admin server (no memory), skills of the app, no write/shell tools.
  expect(o.cwd.endsWith(join("tmp", "control"))).toBe(true);
  expect(Object.keys(o.mcpServers)).toEqual([DISCORD_ADMIN_MCP_SERVER]);
  expect(o.model).toContain("haiku");
  expect(o.tools).not.toContain(WRITE_TOOL_NAME);
  expect(o.tools).not.toContain(BASH_TOOL_NAME);
  expect(o.skills).toHaveLength(1);
  expect(o.plugins).toHaveLength(1);
  expect(
    (await o.canUseTool(WRITE_TOOL_NAME, { file_path: join(o.cwd, "x"), content: "x" }, {}))
      .behavior,
  ).toBe("deny");
  expect(o.systemPrompt.append).toContain("server manager"); // the role's contract
  // The ask relay posts into the control channel (threadId = channel id).
  expect(s.log.asks[0]).toMatchObject({ threadId: CTRL, question: "Create study space english?" });
  // The space was created through the create-only code path.
  expect(s.g.created.map((c) => c.name)).toEqual(["english", "english-agent"]);
  // The write asked the owner with the diff, then wrote.
  expect(s.log.confirms[0]).toMatchObject({ threadId: CTRL, summary: "Create space english" });
  expect(s.log.confirms[1]).toMatchObject({ threadId: CTRL });
  expect(s.log.confirms[1].detail).toContain("+- Patient.");
  const soul = join(s.env.home, "workspaces", "english", "SOUL.md");
  expect(readFileSync(soul, "utf8")).toBe(CONTENT);
  // The reply lands in the channel; the turn and the session are stored under the channel id.
  expect(s.c.sent.join("\n")).toContain("written english/SOUL.md");
  const turn = s.env.db.query<any, []>("SELECT * FROM turns").get();
  expect(turn).toMatchObject({ role: "discord-manager", thread_id: CTRL, status: "done" });
  expect(getSession(s.env.db, CTRL)).toMatchObject({ session_id: "sess-ctl" });
});

test("the next message resumes the channel's session; a no from the owner creates and writes nothing", async () => {
  const s = setup({ approve: false });
  await s.handle(s.c.msg() as any, "make a study space called english");
  expect(s.g.created).toHaveLength(0);
  expect(existsSync(join(s.env.home, "workspaces", "english"))).toBe(false);
  expect(s.c.sent.join("\n")).toContain("not created");
  await s.handle(s.c.msg() as any, "and one more thing");
  expect(s.queries[1].options.resume).toBe("sess-ctl");
});

test("commands keep working and never reach the role", async () => {
  const s = setup();
  await s.handle(s.c.msg() as any, "/init-channel nospace/notes");
  expect(s.queries).toHaveLength(0);
  expect(s.c.sent.join("\n")).toContain("not set up");
});

test("a second message while a run is in flight is told so; stop aborts the run", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const s = setup({
    queryFn: (a: any) =>
      (async function* () {
        yield { ...initMsg, session_id: "s2", cwd: a.options.cwd } as never;
        await gate;
        yield resultMsg({ result: "late answer", session_id: "s2" });
      })(),
  });
  const first = s.handle(s.c.msg() as any, "slow request");
  await Bun.sleep(30);
  await s.handle(s.c.msg() as any, "another");
  expect(s.c.sent.join("\n")).toContain("still running");
  await s.handle(s.c.msg() as any, "/stop");
  expect(s.c.sent.join("\n")).toContain("Stopping.");
  release();
  await first;
  // the slot is free again
  await s.handle(s.c.msg() as any, "/stop");
  expect(s.c.sent.join("\n")).toContain("Nothing is running.");
});

test("without a button flow the control role does not start: the help text answers", async () => {
  const env = makeEnv();
  const c = control(fakeGuild([]).guild);
  const handle = createAdminHandler({
    home: env.home,
    guildId: "G1",
    ownerId: "OWN",
    botId: () => "BOT",
    setup: { controlChannels: [CTRL], ops: {} } as any,
    controlRun: createControlRoleRun({ db: env.db, config: env.config }),
  });
  await handle(c.msg() as any, "make a study space");
  expect(c.sent[0]).toContain("Admin commands");
  expect(c.sent[0]).toContain("server manager");
});

/** A run parked on a gate until released; resolves `started` once the SDK stream began. */
function parkedRun() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const queryFn = (a: any) =>
    (async function* () {
      yield { ...initMsg, session_id: "s3", cwd: a.options.cwd } as never;
      // abort ends the stream like the SDK does: the generator throws on the run's signal
      await Promise.race([
        gate,
        new Promise((_, rej) =>
          a.options.abortController.signal.addEventListener("abort", () =>
            rej(new Error("aborted")),
          ),
        ),
      ]);
      yield resultMsg({ result: "late", session_id: "s3" });
    })();
  return { queryFn, release };
}

test("shutdown: abortAll aborts a running control run; its turn is cancelled and not resumable", async () => {
  const p = parkedRun();
  const s = setup({ queryFn: p.queryFn });
  const run = createControlRoleRun({
    db: s.env.db,
    config: s.env.config,
    approvals: stubGateway({}),
    queryFn: p.queryFn,
  });
  const msg = s.c.msg() as any;
  const first = run(msg, "slow request", {} as never);
  await Bun.sleep(30);
  expect(s.env.db.query<any, []>("SELECT status FROM turns").get()?.status).toBe("running");
  const left = run.drain(2000); // aborts, then waits for the run to end
  await first;
  expect(await left).toBeGreaterThan(0);
  const turn = s.env.db.query<any, []>("SELECT status FROM turns").get();
  expect(turn?.status).toBe("cancelled");
  expect(listInterruptedThreads(s.env.db)).toEqual([]);
  p.release();
});

test("restart: an interrupted control turn is closed without a Continue button", async () => {
  const s = setup();
  insertTurn(s.env.db, {
    id: "t1",
    threadId: CTRL,
    source: "discord",
    location: "*",
    role: "assistant",
  });
  insertTurn(s.env.db, {
    id: "t2",
    threadId: "T9",
    source: "discord",
    location: "*",
    role: "assistant",
  });
  interruptRunningTurns(s.env.db);
  const sent: string[] = [];
  const client: any = {
    channels: {
      fetch: async (id: string) => ({
        isSendable: () => true,
        send: async () => void sent.push(id),
      }),
    },
  };
  const n = await postResumeNotices({
    db: s.env.db,
    getClient: () => client,
    isControlChannel: (id) => id === CTRL,
  });
  expect(n).toBe(1);
  expect(sent).toEqual(["T9"]);
  expect(listInterruptedThreads(s.env.db)).toEqual([]);
});

test("a control session idle for over 24h is not resumed; a fresh one is", async () => {
  const s = setup();
  await s.handle(s.c.msg() as any, "first");
  await s.handle(s.c.msg() as any, "second");
  expect(s.queries[1].options.resume).toBe("sess-ctl");
  s.env.db
    .query("UPDATE sessions SET updated_at = ? WHERE thread_id = ?")
    .run(Date.now() - CONTROL_SESSION_MAX_AGE_MS - 60_000, CTRL);
  await s.handle(s.c.msg() as any, "third");
  expect(s.queries[2].options.resume).toBeUndefined();
});

test("each query() call gets its own admin server instance", async () => {
  const s = setup();
  await s.handle(s.c.msg() as any, "first");
  await s.handle(s.c.msg() as any, "second");
  const a = s.queries[0].options.mcpServers[DISCORD_ADMIN_MCP_SERVER];
  const b = s.queries[1].options.mcpServers[DISCORD_ADMIN_MCP_SERVER];
  expect(a.instance).not.toBe(b.instance);
});
