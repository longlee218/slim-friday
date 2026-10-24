import type { ConversationDto } from "@friday/contracts";
import { expect, test } from "vitest";
import { tabTitle } from "../../src/components/shell/tab-title";

const c = (unread: number): ConversationDto => ({
  id: "bot:dev",
  kind: "direct",
  botId: "dev",
  title: "Dev",
  unread,
});

test("tab title counts unread", () => {
  expect(tabTitle([c(2), c(1)])).toBe("(3) Friday");
  expect(tabTitle([c(0)])).toBe("Friday");
  expect(tabTitle([])).toBe("Friday");
});
