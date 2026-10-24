import { expect, test } from "bun:test";
import type { MemoryOwner, RecallQuery, RecallSource } from "@friday/core";

/** What a contract run needs: a fresh source, and a way to put a note into it for an owner. */
export interface ContractSubject {
  source: RecallSource;
  seed(owner: MemoryOwner, text: string): Promise<void>;
}

const ann: MemoryOwner = { kind: "bot", botId: "ann" };
const bob: MemoryOwner = { kind: "bot", botId: "bob" };
const team: MemoryOwner = { kind: "group", groupId: "team" };

const query = (
  owner: MemoryOwner,
  text: string,
  signal = new AbortController().signal,
): RecallQuery => ({
  owner,
  text,
  limit: 5,
  signal,
});

/**
 * The tests every `RecallSource` must pass (builtin and every provider plugin): owner isolation, safe input,
 * abort, and write/forget when the source has them. `make` builds a fresh, empty subject per test.
 */
export function recallSourceContract(name: string, make: () => Promise<ContractSubject>): void {
  test(`${name}: finds a seeded note for its owner`, async () => {
    const s = await make();
    await s.seed(ann, "deploy uses docker compose");
    const hits = await s.source.search(query(ann, "docker compose"));
    expect(hits.map((h) => h.text).join("\n")).toContain("deploy uses docker compose");
    expect(hits.every((h) => h.source === s.source.id)).toBe(true);
  });

  test(`${name}: never returns another owner's note`, async () => {
    const s = await make();
    await s.seed(ann, "ann secret plan alpha");
    await s.seed(team, "team secret plan alpha");
    for (const other of [bob, { kind: "group", groupId: "other" } as MemoryOwner])
      expect(await s.source.search(query(other, "secret plan alpha"))).toEqual([]);
    const own = await s.source.search(query(team, "secret plan alpha"));
    expect(own.map((h) => h.text).join("\n")).not.toContain("ann secret");
  });

  test(`${name}: empty or punctuation-only text returns [] without throwing`, async () => {
    const s = await make();
    await s.seed(ann, "deploy uses docker");
    expect(await s.source.search(query(ann, ""))).toEqual([]);
    expect(await s.source.search(query(ann, ' "*(): '))).toEqual([]);
  });

  test(`${name}: an aborted signal rejects or returns quickly`, async () => {
    const s = await make();
    await s.seed(ann, "deploy uses docker");
    const ac = new AbortController();
    ac.abort();
    const r = await Promise.race([
      s.source.search(query(ann, "docker", ac.signal)).then(
        () => "done",
        () => "done",
      ),
      Bun.sleep(500).then(() => "hung"),
    ]);
    expect(r).toBe("done");
  });

  test(`${name}: a written note is found; after forget it is not`, async () => {
    const s = await make();
    if (!s.source.write || !s.source.forget) return;
    await s.source.write(ann, { text: "owner prefers short answers", kind: "preference" });
    const found = await s.source.search(query(ann, "short answers"));
    expect(found.map((h) => h.text)).toContain("owner prefers short answers");
    await s.source.forget(ann, "owner prefers short answers");
    const gone = await s.source.search(query(ann, "short answers"));
    expect(gone.map((h) => h.text)).not.toContain("owner prefers short answers");
  });
}
