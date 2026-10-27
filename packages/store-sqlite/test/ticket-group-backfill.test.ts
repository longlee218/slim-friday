import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openEngineDb } from "../src/open-engine-db";

const backfill = readFileSync(
  join(import.meta.dir, "../src/migrations/0018_ticket_group_backfill.sql"),
  "utf8",
);

const T = 1000;

/** Fresh db with the creator bots' wakes and conversations the cases below need. */
const seed = () => {
  const db = openEngineDb(":memory:");
  const conv = (id: string, kind: string, group: string | null) =>
    db.run("INSERT INTO conversations (id, kind, group_id) VALUES (?, ?, ?)", [id, kind, group]);
  conv("group:team", "group", "team");
  conv("group:a", "group", "a");
  conv("group:b", "group", "b");
  conv("bot:dev", "bot", null);
  const wake = (
    id: string,
    bot: string,
    conversation: string,
    start = 900,
    end: number | null = 1100,
  ) =>
    db.run(
      `INSERT INTO wakes (id, chain_id, conversation_id, target_bot, sender_kind, intent, hop, text,
        status, attempts, created_at, started_at, ended_at)
       VALUES (?, ?, ?, ?, 'owner', 'ask', 0, '', 'done', 1, 1, ?, ?)`,
      [id, id, conversation, bot, start, end],
    );
  wake("w1", "one", "group:team");
  wake("w2", "two", "group:a");
  wake("w3", "two", "group:b");
  wake("w4", "four", "bot:dev");
  wake("w5", "five", "group:team");
  wake("w6", "five", "bot:dev");
  wake("w7", "six", "group:a", 100, 500); // ended before created_at
  wake("w8", "seven", "group:b", 900, null); // still running
  const ticket = (
    n: number,
    kind: string,
    bot: string | null,
    conv: string,
    group: string | null,
  ) =>
    db.run(
      `INSERT INTO tickets (id, number, title, status, priority, created_by_kind, created_by_bot_id,
        conversation_id, group_id, created_at, updated_at)
       VALUES (?, ?, 't', 'open', 'normal', ?, ?, ?, ?, ?, ?)`,
      [`t${n}`, n, kind, bot, conv, group, T, T],
    );
  ticket(1, "bot", "one", "bot:dev", null); // one covering run in group:team
  ticket(2, "bot", "two", "bot:dev", null); // covering runs in two groups
  ticket(3, "bot", "three", "group:team", null); // no covering run, group conversation
  ticket(4, "owner", null, "bot:dev", null); // owner, direct conversation
  ticket(5, "bot", "one", "bot:dev", "keep"); // already set
  ticket(6, "bot", "four", "group:team", null); // only covering run is direct -> rule 2
  ticket(7, "bot", "five", "bot:dev", null); // group run plus direct run
  ticket(8, "bot", "six", "bot:dev", null); // run ended before created_at
  ticket(9, "bot", "seven", "bot:dev", null); // open-ended run covers
  return db;
};

test("backfill fills the origin group of existing tickets", () => {
  const db = seed();
  db.run(backfill);
  const rows = db
    .query<{ number: number; group_id: string | null }, []>(
      "SELECT number, group_id FROM tickets ORDER BY number",
    )
    .all();
  expect(rows.map((r) => r.group_id)).toEqual([
    "team",
    null,
    "team",
    null,
    "keep",
    "team",
    "team",
    null,
    "b",
  ]);
  db.close();
});
