import { expect, test } from "vitest";
import { OwnerBubble } from "../../src/components/chat/owner-bubble";
import { ownerTextParts } from "../../src/components/chat/owner-text";
import { msg, view } from "./fixtures";

test("owner text splits fences and inline code, and nothing else", () => {
  expect(ownerTextParts("And code:\n\n```ts\nconst a = 1;\n```\nDone")).toEqual([
    { kind: "text", text: "And code:" },
    { kind: "fence", text: "const a = 1;" },
    { kind: "text", text: "Done" },
  ]);
  expect(ownerTextParts("run `bun test` **now**")).toEqual([
    { kind: "text", text: "run " },
    { kind: "code", text: "bun test" },
    { kind: "text", text: " **now**" },
  ]);
  expect(ownerTextParts("```\nopen to the end")).toEqual([
    { kind: "fence", text: "open to the end" },
  ]);
});

test("an owner bubble renders code as mono and keeps mentions in the text", () => {
  const m = msg({ author: { kind: "user" }, text: "@dev see `x`:\n```ts\nlet y = 2;\n```" });
  const { container } = view(<OwnerBubble message={m} members={["dev"]} />);
  expect(container.querySelector(".bubble .o-code")?.textContent).toBe("x");
  expect(container.querySelector(".bubble pre.o-fence code")?.textContent).toBe("let y = 2;");
  expect(container.querySelector(".at")?.textContent).toBe("@dev");
  expect(container.textContent).not.toContain("```");
});
