import { AdminError, type MemoryAdmin, type MemoryNote } from "@friday/core";
import { type FileMemory, MemoryError } from "../memory/file-memory";
import { readJournal } from "../memory/journal-read";
import { readRules, writeRules } from "../memory/rules-file";

/** What `createMemoryAdmin` needs: the app's `FileMemory` (so its `onChange` still fires), its root and the prompt cap. */
export interface MemoryAdminDeps {
  memory: FileMemory;
  root: string;
  /** Memory prompt cap shown next to `promptChars` (`memoryPromptChars`). */
  capChars: number;
}

/** Run a memory write and turn a `MemoryError` into the admin error the API returns; others are rethrown. */
async function mapped(write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (err) {
    if (!(err instanceof MemoryError)) throw err;
    if (err.code === "empty" || err.code === "too_long")
      throw new AdminError("BAD_REQUEST", err.message, "text");
    if (err.code === "not_found") throw new AdminError("NOT_FOUND", "note not found");
    throw new AdminError("CONFLICT", err.message);
  }
}

/** `MemoryAdmin` over the existing memory files: notes through `FileMemory`, journal and rules read and written in place. */
export function createMemoryAdmin({ memory, root, capChars }: MemoryAdminDeps): MemoryAdmin {
  return {
    async list(o) {
      const notes = memory
        .listBullets(o)
        .filter((b): b is typeof b & { kind: MemoryNote["kind"] } => b.kind !== "open")
        .map((b) => ({ id: b.id, kind: b.kind, text: b.text, day: b.day }));
      const promptChars = (await memory.readForPrompt(o, capChars)).text.length;
      return { notes, promptChars, capChars };
    },
    save: (o, kind, text) => mapped(() => memory.save(o, text, kind)),
    edit: (o, id, text) => mapped(() => memory.edit(o, id, text)),
    delete: (o, id) => mapped(() => memory.edit(o, id, null)),
    journal: (o, day) => readJournal(root, o, day),
    rules: (o) => readRules(root, o),
    saveRules: (o, rules) => writeRules(root, o, rules),
  };
}
