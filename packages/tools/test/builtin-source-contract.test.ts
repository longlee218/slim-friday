import { builtinSource } from "../src/memory/recall/builtin-source";
import { FakeIndexStore } from "./fake-index-store";
import { recallSourceContract } from "./recall-source-contract";

recallSourceContract("builtin", async () => {
  const store = new FakeIndexStore();
  let n = 0;
  return {
    source: builtinSource(store),
    seed: async (owner, text) => {
      n++;
      store.upsertDoc(owner, `memory-${n}`, String(n), [{ ref: `r${n}`, path: "MEMORY.md", text }]);
    },
  };
});
