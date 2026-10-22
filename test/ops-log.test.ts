import { expect, test } from "bun:test";
import { ChannelType, PermissionFlagsBits as P } from "discord.js";
import { captureLogs } from "../src/observability/logger";
import { formatChannelList, scrub } from "../src/providers/discord/setup/bootstrap-discord-cli";
import { createOpsLog, opsLogLine } from "../src/providers/discord/setup/ops-log";
import { warnIfBotAdministrator } from "../src/providers/discord/setup/ready-checks";

const TOKEN = `${"M".padEnd(24, "a")}.${"b".repeat(6)}.${"c".repeat(27)}`;

test("opsLogLine redacts secrets and clips to 200 chars", () => {
  expect(opsLogLine("start", "pid=1 v0.1.0")).toBe("[start] pid=1 v0.1.0");
  expect(opsLogLine("error", new Error(`failed with ${TOKEN}`))).not.toContain(TOKEN);
  expect(opsLogLine("shutdown", `reason ${TOKEN}`)).toContain("[REDACTED]");
  expect(opsLogLine("error", "x".repeat(500)).length).toBeLessThanOrEqual(`[error] `.length + 200);
});

test("no ops.log channel: post is a no-op (client never touched)", async () => {
  let touched = false;
  const ops = createOpsLog(() => {
    touched = true;
    return undefined;
  });
  await ops.post("start", "x");
  expect(touched).toBe(false);
});

test("posts one redacted line; a failing channel is logged, never thrown", async () => {
  const sent: any[] = [];
  const client: any = {
    channels: {
      fetch: async () => ({ isSendable: () => true, send: async (o: any) => void sent.push(o) }),
    },
  };
  await createOpsLog(() => client, "1").post("error", `boom ${TOKEN}`);
  expect(sent).toHaveLength(1);
  expect(sent[0].content).toStartWith("[error] boom");
  expect(sent[0].content).not.toContain(TOKEN);
  expect(sent[0].allowedMentions).toEqual({ parse: [], repliedUser: false });

  const logs = captureLogs();
  const broken: any = {
    channels: { fetch: async () => Promise.reject(new Error("Missing Access")) },
  };
  await createOpsLog(() => broken, "1").post("start", "x"); // resolves
  await createOpsLog(() => undefined, "1").post("start", "x"); // client gone: resolves
  logs.stop();
  expect(logs.lines.some((l) => l.msg === "ops-log post failed")).toBe(true);
});

test("warnIfBotAdministrator logs discord.bot_administrator only for Administrator", () => {
  const client = (bits: bigint): any => ({
    guilds: { cache: new Map([["G", { members: { me: { permissions: { bitfield: bits } } } }]]) },
  });
  const logs = captureLogs();
  expect(warnIfBotAdministrator(client(P.ManageChannels), "G")).toBe(false);
  expect(warnIfBotAdministrator(client(P.Administrator), "G")).toBe(true);
  expect(warnIfBotAdministrator(client(P.Administrator), undefined)).toBe(false);
  expect(warnIfBotAdministrator(client(P.Administrator), "OTHER")).toBe(false);
  logs.stop();
  const warns = logs.lines.filter((l) => l.event === "discord.bot_administrator");
  expect(warns).toHaveLength(1);
  expect(warns[0]).toMatchObject({ level: 40 });
});

test("formatChannelList lists category / name / id for every channel", () => {
  const lines = formatChannelList([
    { id: "10", name: "Old", type: ChannelType.GuildCategory, parentId: null },
    { id: "11", name: "general", type: ChannelType.GuildText, parentId: "10" },
    { id: "12", name: "loose", type: ChannelType.GuildText, parentId: null },
  ]);
  expect(lines).toContain("Old / general / 11");
  expect(lines).toContain("(no category) / loose / 12");
  expect(lines).toContain("(no category) / [category] Old / 10");
  expect(lines).toHaveLength(3);
});

test("a hostile rejection reason does not throw and the shutdown post still works", async () => {
  const sent: any[] = [];
  const client: any = {
    channels: {
      fetch: async () => ({ isSendable: () => true, send: async (o: any) => void sent.push(o) }),
    },
  };
  const ops = createOpsLog(() => client, "1");
  await ops.post("error", Object.create(null));
  await ops.post("shutdown", "SIGTERM");
  expect(sent.map((s) => s.content)).toEqual(["[error] unprintable error", "[shutdown] SIGTERM"]);
});

test("error lines: same message once per minute, max 5 per minute; start/shutdown never limited", async () => {
  const sent: string[] = [];
  const client: any = {
    channels: {
      fetch: async () => ({
        isSendable: () => true,
        send: async (o: any) => void sent.push(o.content),
      }),
    },
  };
  let t = 1_000_000;
  const ops = createOpsLog(
    () => client,
    "1",
    () => t,
  );
  for (let i = 0; i < 3; i++) await ops.post("error", "same");
  expect(sent).toEqual(["[error] same"]);
  t += 61_000;
  await ops.post("error", "same");
  expect(sent).toHaveLength(2);
  for (let i = 0; i < 10; i++) await ops.post("error", `distinct ${i}`);
  expect(sent.filter((l) => l.startsWith("[error]"))).toHaveLength(6); // 1 old + 5 in the last minute
  await ops.post("shutdown", "x");
  expect(sent.at(-1)).toBe("[shutdown] x");
});

test("a failing post never posts again (no loop): one fetch per post call", async () => {
  let fetches = 0;
  const client: any = {
    channels: {
      fetch: async () => {
        fetches++;
        throw new Error("no");
      },
    },
  };
  await createOpsLog(() => client, "1").post("error", "boom");
  expect(fetches).toBe(1);
});

test("scrub: empty token leaves text intact, real token masked", () => {
  expect(scrub("failed here", "")).toBe("failed here");
  expect(scrub("bad abc123 token", "abc123")).toBe("bad [REDACTED] token");
});
