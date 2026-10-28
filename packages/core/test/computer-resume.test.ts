import { expect, test } from "bun:test";
import { type BotId, computerResume, RESUME_NOTE } from "../src";

const bot = (s: string) => s as BotId;

function setup() {
  const woken: { botId: string; text: string; key: string }[] = [];
  const resume = computerResume(async (botId, text, key) => {
    woken.push({ botId, text, key });
  });
  return { resume, woken };
}

test("one wake per blocked bot, even when called twice", async () => {
  const { resume, woken } = setup();
  resume.noteBlockedByOwner(bot("a"), "home");
  resume.noteBlockedByOwner(bot("a"), "home");
  resume.noteBlockedByOwner(bot("b"), "home");
  await resume.resumeAfterGiveBack("home");
  await resume.resumeAfterGiveBack("home");
  expect(woken.map((w) => w.botId).sort()).toEqual(["a", "b"]);
  expect(woken[0]?.text).toBe(RESUME_NOTE);
  expect(RESUME_NOTE).toBe("the owner used the computer; check its state before continuing");
});

test("a bot that was not blocked, or blocked on another computer, gets no wake", async () => {
  const { resume, woken } = setup();
  resume.noteBlockedByOwner(bot("a"), "other");
  await resume.resumeAfterGiveBack("home");
  expect(woken).toEqual([]);
  await resume.resumeAfterGiveBack("other");
  expect(woken.map((w) => w.botId)).toEqual(["a"]);
});

test("a failed wake does not stop the others", async () => {
  const woken: string[] = [];
  const resume = computerResume(async (botId) => {
    if (botId === "a") throw new Error("boom");
    woken.push(botId);
  });
  resume.noteBlockedByOwner(bot("a"), "home");
  resume.noteBlockedByOwner(bot("b"), "home");
  await resume.resumeAfterGiveBack("home");
  expect(woken).toEqual(["b"]);
});

test("the wake key is unique across engine restarts: a new instance never reuses an old give-back's key", async () => {
  const keysOf = async () => {
    const seen: string[] = [];
    const r = computerResume(async (_bot, _text, key) => {
      seen.push(key);
    });
    r.noteBlockedByOwner("ann", "box");
    await r.resumeAfterGiveBack("box");
    return seen;
  };
  const first = await keysOf();
  const second = await keysOf();
  expect(first).toHaveLength(1);
  expect(second).toHaveLength(1);
  expect(first[0]).not.toBe(second[0]);
});
