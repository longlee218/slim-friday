import { expect, test } from "bun:test";
import { createDecisionPoster, EXPIRED_REPLY } from "../src/approvals/clone-decision";
import { tid } from "./clone-fixture";

// Keep/Discard buttons: customId clone:<keep|discard>:<taskId>, UUID-checked, memory-only, fail closed.

const OWNER = "owner";
const ID = tid("bbbb2222");

/** Poster with a fake channel; `click` fakes a button interaction and returns what the bot answered. */
function setup() {
  const sent: any[] = [];
  const client = {
    channels: {
      fetch: async () => ({ isSendable: () => true, send: async (m: any) => sent.push(m) }),
    },
  } as never;
  const poster = createDecisionPoster({ getClient: () => client, ownerId: OWNER });
  const click = async (p: typeof poster, customId: string, user = OWNER) => {
    const out: { reply?: string; update?: string } = {};
    const handled = await p.handle({
      isButton: () => true,
      customId,
      user: { id: user },
      reply: async (r: any) => {
        out.reply = r.content;
      },
      update: async (r: any) => {
        out.update = r.content;
      },
    } as never);
    return { handled, ...out };
  };
  return { sent, poster, click };
}

test("post builds customIds clone:<choice>:<taskId>; a click runs onClick once", async () => {
  const s = setup();
  const seen: string[] = [];
  const ok = await s.poster.post({
    taskId: ID,
    threadId: "th",
    content: "result",
    onClick: async (c) => {
      seen.push(c);
      return "done";
    },
  });
  expect(ok).toBe(true);
  const ids = s.sent[0].components[0].components.map((b: any) => b.data.custom_id);
  expect(ids).toEqual([`clone:keep:${ID}`, `clone:discard:${ID}`]);
  expect((await s.click(s.poster, ids[0])).update).toContain("done");
  expect(seen).toEqual(["keep"]);
  expect((await s.click(s.poster, ids[0])).reply).toBe(EXPIRED_REPLY); // second click
  expect(seen).toEqual(["keep"]);
});

test("after a restart (fresh poster) every click is expired with no side effect", async () => {
  const s = setup();
  let ran = 0;
  await s.poster.post({
    taskId: ID,
    threadId: "th",
    content: "r",
    onClick: async () => {
      ran++;
      return "x";
    },
  });
  const restarted = setup().poster; // same customIds, no memory of the message
  const r = await setup().click(restarted, `clone:discard:${ID}`);
  expect(r.reply).toBe(EXPIRED_REPLY);
  expect(ran).toBe(0);
});

test("malformed ids, unknown choices and strangers fail closed; other prefixes are not ours", async () => {
  const s = setup();
  let ran = 0;
  await s.poster.post({
    taskId: ID,
    threadId: "th",
    content: "r",
    onClick: async () => {
      ran++;
      return "x";
    },
  });
  for (const id of [
    "clone:keep:../../etc",
    `clone:wipe:${ID}`,
    `clone:keep:${ID}:extra`,
    "clone:keep:",
    "clone::",
  ])
    expect((await s.click(s.poster, id)).reply).toBe(EXPIRED_REPLY);
  expect((await s.click(s.poster, `clone:keep:${ID}`, "stranger")).reply).toContain("owner");
  expect(ran).toBe(0);
  expect((await s.click(s.poster, "appr:abc:allow")).handled).toBe(false);
});
