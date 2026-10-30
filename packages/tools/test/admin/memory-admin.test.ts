import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryAdmin } from "../../src/admin/memory-admin";
import { FileMemory } from "../../src/memory/file-memory";

const dev = { kind: "bot", botId: "dev" } as const;
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "madmin-"));
  let changes = 0;
  const memory = new FileMemory(
    root,
    () => new Date(2026, 9, 24),
    () => void changes++,
  );
  return {
    root,
    admin: createMemoryAdmin({ memory, root, capChars: 12000 }),
    changes: () => changes,
  };
};
const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e) => e.code,
  );

test("save/edit/delete go through FileMemory and fire onChange", async () => {
  const { admin, changes } = setup();
  await admin.save(dev, "fact", "Uses Bun.");
  let { notes, promptChars, capChars } = await admin.list(dev);
  expect(notes).toEqual([
    { id: expect.any(String), kind: "fact", text: "Uses Bun.", day: "2026-10-24" },
  ]);
  expect(promptChars).toBeGreaterThan(0);
  expect(capChars).toBe(12000);
  await admin.edit(dev, notes[0].id, "Uses Bun 1.3.");
  ({ notes } = await admin.list(dev));
  expect(notes[0].text).toBe("Uses Bun 1.3.");
  await admin.delete(dev, notes[0].id);
  expect((await admin.list(dev)).notes).toEqual([]);
  expect(changes()).toBe(3);
});

test("refusals map to admin codes", async () => {
  const { admin } = setup();
  await admin.save(dev, "fact", "Same.");
  expect(await code(admin.save(dev, "fact", "Same."))).toBe("CONFLICT");
  expect(await code(admin.save(dev, "fact", "  "))).toBe("BAD_REQUEST");
  expect(await code(admin.save(dev, "fact", "a".repeat(201)))).toBe("BAD_REQUEST");
});

test("editing a note that changed meanwhile is a conflict", async () => {
  const { admin } = setup();
  await admin.save(dev, "fact", "Uses Bun.");
  const old = (await admin.list(dev)).notes[0].id;
  await admin.edit(dev, old, "Uses Bun 1.3.");
  const err = await admin.edit(dev, old, "Stale text.").catch((e) => e);
  expect(err.code).toBe("CONFLICT");
  expect(err.message).toBe(
    "This note changed since the list loaded. The list was reloaded; edit it again.",
  );
  const gone = await admin.delete(dev, old).catch((e) => e);
  expect(gone.code).toBe("CONFLICT");
  expect(gone.message).toBe("This note is already gone or changed. The list was reloaded.");
});

test("rules and journal through the admin", async () => {
  const { admin } = setup();
  admin.saveRules(dev, [{ text: "r", on: false }]);
  expect(admin.rules(dev)).toEqual([{ text: "r", on: false }]);
  expect(admin.journal(dev)).toEqual([]);
});

test("group owner writes under groups/<id>", async () => {
  const { admin, root } = setup();
  const g = { kind: "group", groupId: "team" } as const;
  await admin.save(g, "lesson", "Be brief.");
  expect((await admin.list(g)).notes[0].kind).toBe("lesson");
  expect(Bun.file(join(root, "groups", "team", "MEMORY.md")).size).toBeGreaterThan(0);
});
