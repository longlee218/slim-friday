import type { GroupDto } from "@friday/contracts";
import { expect, test } from "vitest";
import {
  insertMention,
  mentioned,
  mentionQuery,
  routeChipText,
  routeOf,
} from "../../src/components/chat/mentions";

const crew = {
  id: "crew",
  name: "Crew",
  members: ["pia", "tess", "dev"],
  entryBot: "pia",
} as GroupDto;
const members = [
  { id: "tess", name: "Tess" },
  { id: "dev", name: "Dev" },
];
const names = new Map([
  ["pia", "Pia"],
  ["tess", "Tess"],
  ["dev", "Dev"],
]);

test("mention query at the caret", () => {
  expect(mentionQuery("hi @De", 6)).toBe("de");
  expect(mentionQuery("mail@x", 6)).toBe("x");
  expect(mentionQuery("hi", 2)).toBeNull();
  expect(mentionQuery("hi @", 4)).toBe("");
  // The caret decides, not the end of the text.
  expect(mentionQuery("@De rest", 3)).toBe("de");
});

test("mentioned members, unique and in order", () => {
  expect(mentioned("@tess and @Dev and @tess @nobody", members)).toEqual(["tess", "dev"]);
});

test("insertMention", () => {
  expect(insertMention("hi @de", 6, "Dev")).toEqual({ text: "hi @Dev ", caret: 8 });
  expect(insertMention("@d tail", 2, "Dev")).toEqual({ text: "@Dev  tail", caret: 5 });
});

test("route: named > reply > entry", () => {
  expect(routeChipText(routeOf({ text: "go", group: crew, names }), names)).toBe("To Pia · entry");
  expect(
    routeChipText(routeOf({ text: "go", replyToBotId: "dev", group: crew, names }), names),
  ).toBe("To Dev · reply");
  expect(
    routeChipText(routeOf({ text: "@Tess go", replyToBotId: "dev", group: crew, names }), names),
  ).toBe("To Tess");
  expect(routeChipText(routeOf({ text: "@Tess @Dev", group: crew, names }), names)).toBe(
    "To Tess, Dev",
  );
});
