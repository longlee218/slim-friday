import type { MessageDto } from "@friday/contracts";
import { expect, test } from "vitest";
import type { Directory } from "../../src/api/directory";
import { previewOf } from "../../src/components/shell/chat-rows";

const dir = { botName: (id: string) => id } as unknown as Directory;
const msg = (text: string): MessageDto => ({
  id: 1,
  conversationId: "bot:dev",
  author: { kind: "bot", botId: "dev" },
  kind: "text",
  text,
  at: 0,
  files: [],
});

test("a preview reads as one line: no code fences, backticks or line breaks", () => {
  expect(previewOf(msg("And code:\n```ts\nconst a = 1;\n```"), dir)).toBe("And code: const a = 1;");
  expect(previewOf(msg("Run `bun test` now"), dir)).toBe("Run bun test now");
});
