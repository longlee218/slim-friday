import { expect, test } from "bun:test";
import type { MemoryProviderPlugin, RecallNote, RecallSource } from "../src";

test("a plugin turns its options and secrets into a source that may write and forget", () => {
  const written: RecallNote[] = [];
  const plugin: MemoryProviderPlugin<{ url: string }> = {
    id: "fake",
    secretEnv: ["FAKE_KEY"],
    parseOptions: (raw) => ({ url: String(raw.url) }),
    check: (o, secrets) => (secrets.FAKE_KEY ? [] : [`no key for ${o.url}`]),
    create: (): RecallSource => ({
      id: "fake",
      search: async () => [],
      write: async (_o, note) => void written.push(note),
      forget: async () => {},
    }),
  };
  const opts = plugin.parseOptions({ url: "x" });
  expect(plugin.check(opts, {})).toEqual(["no key for x"]);
  const s = plugin.create(opts, { FAKE_KEY: "k" }, { log: { warn() {} } });
  void s.write?.({ kind: "bot", botId: "a" }, { text: "t", kind: "fact" });
  expect(written).toEqual([{ text: "t", kind: "fact" }]);
});
