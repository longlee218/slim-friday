import { expect, test } from "vitest";
import { edgeSwipePop, edgeSwipeStart } from "../../src/components/phone/edge-swipe";
import {
  backLabel,
  phoneStackFor,
  phoneStackReduce,
  tabOf,
} from "../../src/components/phone/phone-stack";

test("tabOf maps paths to tabs (chats own / and /c/*)", () => {
  expect(tabOf("/")).toBe("chats");
  expect(tabOf("/c/bot:dev")).toBe("chats");
  expect(tabOf("/tickets/FRI-1")).toBe("tickets");
  expect(tabOf("/ops")).toBe("activity");
  expect(tabOf("/settings/bot/dev")).toBe("settings");
  expect(tabOf("/schedules")).toBe("settings");
  expect(tabOf("/schedules/a")).toBe("settings");
});

test("phoneStackFor seeds the chat", () => {
  expect(phoneStackFor("/c/bot:dev")).toEqual(["/", "/c/bot:dev"]);
  expect(phoneStackFor("/ops")).toEqual(["/ops"]);
  expect(phoneStackFor("/settings/bot/dev")).toEqual(["/settings", "/settings/bot/dev"]);
});

test("schedules sit under Settings; a schedule opened cold sits on the list", () => {
  expect(phoneStackFor("/schedules")).toEqual(["/settings", "/schedules"]);
  expect(phoneStackFor("/schedules/a")).toEqual(["/settings", "/schedules", "/schedules/a"]);
  expect(backLabel(["/settings", "/schedules"])).toBe("Settings");
  expect(backLabel(["/settings", "/schedules", "/schedules/a"])).toBe("Schedules");
  expect(backLabel(["/", "/c/bot:dev", "/schedules/a"])).toBe("Chat");
});

test("push, pop and tab switch", () => {
  const s = phoneStackReduce(["/", "/c/bot:dev"], { type: "PUSH", path: "/settings/bot/dev" });
  expect(s).toEqual(["/", "/c/bot:dev", "/settings/bot/dev"]);
  expect(phoneStackReduce(s, { type: "POP", path: "/c/bot:dev" })).toEqual(["/", "/c/bot:dev"]);
  expect(phoneStackReduce(s, { type: "PUSH", path: "/tickets" })).toEqual(["/tickets"]);
});

test("pop to a path outside the stack reseeds; replace swaps the top", () => {
  expect(phoneStackReduce(["/"], { type: "POP", path: "/c/bot:pia" })).toEqual(["/", "/c/bot:pia"]);
  expect(phoneStackReduce(["/", "/c/bot:dev"], { type: "REPLACE", path: "/c/bot:pia" })).toEqual([
    "/",
    "/c/bot:pia",
  ]);
  // Replacing with the entry underneath is a back step.
  expect(
    phoneStackReduce(["/", "/c/bot:dev", "/settings/bot/dev"], {
      type: "REPLACE",
      path: "/c/bot:dev",
    }),
  ).toEqual(["/", "/c/bot:dev"]);
});

test("back label reads Chat under a chat", () => {
  expect(backLabel(["/", "/c/bot:dev", "/settings/bot/dev"])).toBe("Chat");
  expect(backLabel(["/", "/c/bot:dev"])).toBe("Chats");
  expect(backLabel(["/settings", "/settings/bot/dev"])).toBe("Settings");
  expect(backLabel(["/tickets", "/tickets/FRI-1"])).toBe("Tickets");
});

test("edge swipe thresholds", () => {
  expect(edgeSwipeStart(24)).toBe(true);
  expect(edgeSwipeStart(25)).toBe(false);
  expect(edgeSwipePop(130, 390)).toBe(true);
  expect(edgeSwipePop(128, 390)).toBe(false);
});
