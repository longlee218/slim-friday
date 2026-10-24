import { expect, test } from "vitest";
import { type MdNode, remarkTicketRefs } from "../../src/components/markdown/remark-ticket-refs";

/** Run the plugin over a hand-built tree (the plugin only walks `children`). */
function run(children: MdNode[]): MdNode {
  const tree: MdNode = { type: "root", children };
  remarkTicketRefs()(tree);
  return tree;
}
const para = (...children: MdNode[]): MdNode => ({ type: "paragraph", children });
const text = (value: string): MdNode => ({ type: "text", value });

test("turns FRI-n in text into a link node", () => {
  const tree = run([para(text("See FRI-21 now"))]);
  const kids = tree.children?.[0]?.children ?? [];
  expect(kids.map((c) => c.type)).toEqual(["text", "link", "text"]);
  expect(kids[1]?.url).toBe("/tickets/FRI-21");
  expect(kids[1]?.children?.[0]?.value).toBe("FRI-21");
});

test("leaves code, inline code and existing links alone", () => {
  const tree = run([
    para(
      { type: "inlineCode", value: "FRI-1" },
      { type: "link", url: "https://x.dev", children: [text("FRI-2")] },
    ),
    { type: "code", value: "FRI-3" },
  ]);
  expect(JSON.stringify(tree)).not.toContain("/tickets/");
});

test("does not match inside a longer word", () => {
  expect(JSON.stringify(run([para(text("AFRI-4 FRI- FRI-5x"))]))).not.toContain("/tickets/");
});
