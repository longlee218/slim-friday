import { expect, test } from "bun:test";
import { parseSettingsFile } from "@friday/config";
import { resolveOwnerTimeZone } from "../src/config/owner-time-zone";

test("the configured zone wins; without one the machine's zone is used", () => {
  expect(resolveOwnerTimeZone("Europe/Paris")).toBe("Europe/Paris");
  expect(resolveOwnerTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
});

test("settings.yaml owner.timeZone must be a known IANA zone", () => {
  expect(parseSettingsFile("owner:\n  timeZone: Europe/Paris\n").owner?.timeZone).toBe(
    "Europe/Paris",
  );
  expect(() => parseSettingsFile("owner:\n  timeZone: Mars/Base\n")).toThrow();
});
