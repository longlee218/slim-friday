import { expect, test } from "bun:test";
import type { FridayEvent } from "@friday/contracts";
import { FridayEventSchema } from "@friday/contracts";
import { FakeClock } from "../../core/test/fakes/fake-clock";
import { FakeFileStore } from "../../core/test/fakes/fake-file-store";
import { FakeStore } from "../../core/test/fakes/fake-store";
import { WebSurface } from "../src/web-surface";

test("notifyFinished publishes a run.finished event that matches the contract", () => {
  const surface = new WebSurface({
    store: new FakeStore(),
    files: new FakeFileStore(),
    clock: new FakeClock(1000),
    inboxDir: "/unused",
  });
  const seen: FridayEvent[] = [];
  const orig = surface.bus.publish.bind(surface.bus);
  surface.bus.publish = (e) => {
    seen.push(e);
    return orig(e);
  };
  surface.notifyFinished({ conversationId: "bot:a", botId: "a", preview: "All done." });
  expect(seen).toEqual([
    { type: "run.finished", conversationId: "bot:a", botId: "a", preview: "All done." },
  ]);
  expect(FridayEventSchema.safeParse(seen[0]).success).toBe(true);
});
