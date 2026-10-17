import { expect, test } from "bun:test";
import { parseSlash } from "../src/commands/slash-commands";
import { SLASH_DEFINITIONS, slashPayload, slashText } from "../src/commands/slash-definitions";
import { createSlashHandler } from "../src/ingress/slash-interaction";
import { ROLES } from "../src/roles/role-registry";

const OWNER = "111";

/** A fake `/limits` interaction; `reply` records every call. */
function fake(userId: string, opts: Record<string, unknown> = {}) {
  const replies: any[] = [];
  const i: any = {
    id: "I1",
    commandName: "limits",
    user: { id: userId, bot: false },
    channel: undefined, // /limits must not need a channel
    isChatInputCommand: () => true,
    options: { get: (n: string) => (n in opts ? { value: opts[n] } : null) },
    reply: async (o: any) => void replies.push(o),
    deferReply: async () => void replies.push("DEFER"),
    editReply: async () => {},
  };
  return { i, replies };
}

function handler(text: string, head = text, fail = false) {
  const calls: unknown[][] = [];
  const messages: unknown[] = [];
  const handle = createSlashHandler({
    ownerId: OWNER,
    onMessage: async (m) => void messages.push(m),
    limits: async (role, language) => {
      calls.push([role, language]);
      if (fail) throw new Error("boom");
      return { text, head };
    },
  });
  return { handle, calls, messages };
}

test("role choices stay within the Discord limit of 25", () => {
  const n = Object.keys(ROLES).length;
  expect(
    n,
    `Discord allows 25 choices per option; ${n} roles: use autocomplete instead`,
  ).toBeLessThanOrEqual(25);
});

test("/limits is registered with an optional role choice from ROLES", () => {
  expect(parseSlash("/limits")).toEqual({ name: "limits", arg: "" });
  expect(parseSlash("/limits developer")).toEqual({ name: "limits", arg: "developer" });
  expect(SLASH_DEFINITIONS.limits.arg?.required).toBe(false);
  const cmd = slashPayload().find((c) => c.name === "limits");
  const opt = cmd?.options[0] as any;
  expect(opt.required).toBe(false);
  expect(opt.choices.map((c: any) => c.value)).toEqual(Object.keys(ROLES));
  expect(slashText("limits", (a) => (a === "role" ? "scout" : null))).toBe("/limits scout");
});

test("owner: ephemeral reply, role arg passed, no message path, no defer", async () => {
  const { handle, calls, messages } = handler("short text");
  const { i, replies } = fake(OWNER, { role: "developer" });
  await handle(i);
  expect(calls[0]?.[0]).toBe("developer");
  expect(replies).toHaveLength(1);
  expect(replies[0].content).toBe("short text");
  expect(replies[0].flags).toBe(64); // MessageFlags.Ephemeral
  expect(messages).toEqual([]);
});

test("no role arg means all roles (undefined)", async () => {
  const { handle, calls } = handler("x");
  await handle(fake(OWNER).i);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.[0]).toBeUndefined();
});

test("stranger gets the private refusal and the view is never built", async () => {
  const { handle, calls } = handler("secret");
  const { i, replies } = fake("222");
  await handle(i);
  expect(calls).toEqual([]);
  expect(replies[0].flags).toBe(64);
  expect(replies[0].content).not.toContain("secret");
});

test("long text: head in the message body, full text as the file limits.md, still ephemeral", async () => {
  const long = `title\n${"x".repeat(2500)}`;
  const { handle } = handler(long, "title");
  const { i, replies } = fake(OWNER);
  await handle(i);
  expect(replies).toHaveLength(1);
  expect(replies[0].flags).toBe(64);
  expect(replies[0].content).toBe("title");
  const file = replies[0].files[0];
  expect(file.name).toBe("limits.md");
  expect(file.attachment.toString()).toBe(long);
});

test("a failing view gives a short ephemeral notice and nothing throws", async () => {
  const { handle } = handler("x", "x", true);
  const { i, replies } = fake(OWNER);
  await handle(i);
  expect(replies).toHaveLength(1);
  expect(replies[0].flags).toBe(64);
  expect(replies[0].content.length).toBeGreaterThan(0);
  expect(replies[0].files).toBeUndefined();
});

test("liveState and the view fail soft: a throwing limiter becomes the same notice", async () => {
  const handle = createSlashHandler({
    ownerId: OWNER,
    onMessage: async () => {},
    limits: () => {
      throw new Error("sync boom");
    },
  });
  const { i, replies } = fake(OWNER);
  await handle(i);
  expect(replies).toHaveLength(1);
  expect(replies[0].flags).toBe(64);
});
