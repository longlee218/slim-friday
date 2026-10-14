import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { locationMemoryFile } from "../src/memory/location-memory";
import { buildPromptContext } from "../src/memory/prompt-context";
import { captureLogs } from "../src/observability/logger";
import { addLocation, makeEnv } from "./helpers";

const WS = "main";
const ctx = (home: string, locations: string[]) =>
  buildPromptContext({ agentHome: home, workspace: WS, memoryLocations: locations });

/** A location memory of `chars` body chars with at least one section. */
const fill = (home: string, location: string, chars: number) =>
  writeFileSync(
    locationMemoryFile(home, WS, location),
    `# ${location}\n\n## s\n- ${"y".repeat(chars)}\n`,
  );

test("a layer cut at read logs memory.truncated and sets memoryOverCap in prompt.context", () => {
  const env = makeEnv();
  fill(env.home, "location", 9000);
  const logs = captureLogs();
  ctx(env.home, ["location"]);
  logs.stop();
  expect(logs.lines.find((l) => l.event === "memory.truncated")).toMatchObject({
    level: 40,
    files: ["location"],
  });
  expect(logs.lines.find((l) => l.event === "prompt.context")).toMatchObject({
    memoryOverCap: ["location"],
  });
});

test("a location skipped by the 16000 total logs memory.location_skipped", () => {
  const env = makeEnv();
  for (const r of ["a", "b", "c"]) addLocation(env.home, r);
  for (const r of ["a", "b", "c"]) fill(env.home, r, 7500);
  const logs = captureLogs();
  ctx(env.home, ["a", "b", "c"]);
  logs.stop();
  expect(logs.lines.find((l) => l.event === "memory.location_skipped")).toMatchObject({
    locations: ["c"],
  });
  expect(logs.lines.find((l) => l.event === "prompt.context")).toMatchObject({ memoryOverCap: [] });
});

test("nothing over cap: no truncation events", () => {
  const env = makeEnv();
  const logs = captureLogs();
  ctx(env.home, ["location"]);
  logs.stop();
  expect(
    logs.lines.some((l) => l.event === "memory.truncated" || l.event === "memory.location_skipped"),
  ).toBe(false);
});
