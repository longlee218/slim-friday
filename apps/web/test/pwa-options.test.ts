import { expect, test } from "vitest";
import { pwaOptions } from "../pwa-options";

test("no runtime caching and API paths denied", () => {
  expect(pwaOptions.workbox?.runtimeCaching ?? []).toEqual([]);
  expect(pwaOptions.workbox?.navigateFallbackDenylist?.map(String)).toEqual([
    "/^\\/rpc/",
    "/^\\/api\\//",
  ]);
});

test("lazy shiki/mermaid chunks stay out of the precache", () => {
  expect(pwaOptions.workbox?.globIgnores).toEqual(["**/assets/lazy/**"]);
});

test("manifest is standalone with three icons", () => {
  expect(pwaOptions.manifest).toMatchObject({ display: "standalone", name: "Friday" });
  expect(pwaOptions.manifest).toMatchObject({ icons: [{}, {}, { purpose: "maskable" }] });
});

test("a new version waits for the app to reload into it", () => {
  expect(pwaOptions.registerType).toBe("prompt");
});
