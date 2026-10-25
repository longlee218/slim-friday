import { QueryClient } from "@tanstack/react-query";
import { beforeEach, expect, test } from "vitest";
import { clearRuns, endRunsExcept, runStep, startRun } from "../../src/events/apply-runs";
import { liveRunKey } from "../../src/events/client-keys";
import { step } from "./fixtures";

let qc: QueryClient;
const runs = () => Object.keys(qc.getQueryData<object>(liveRunKey("bot:dev")) ?? {});
beforeEach(() => {
  qc = new QueryClient();
});

test("a status read before the session opened keeps a young optimistic run", () => {
  startRun(qc, "bot:dev", "dev", 1_000);
  endRunsExcept(qc, new Set(), 2_000);
  expect(runs()).toEqual(["dev"]);
});

test("an optimistic run never confirmed ends after the grace", () => {
  startRun(qc, "bot:dev", "dev", 1_000);
  endRunsExcept(qc, new Set(), 31_000);
  expect(runs()).toEqual([]);
});

test("a run confirmed by a server event ends as soon as its bot is absent", () => {
  startRun(qc, "bot:dev", "dev", 1_000);
  startRun(qc, "bot:dev", "dev", 1_500, true);
  endRunsExcept(qc, new Set(), 2_000);
  expect(runs()).toEqual([]);
  startRun(qc, "bot:dev", "dev", 3_000);
  runStep(qc, "bot:dev", "dev", step("tool", "running"));
  endRunsExcept(qc, new Set(), 3_100);
  expect(runs()).toEqual([]);
});

test("clearRuns empties the record a mounted view observes", () => {
  startRun(qc, "bot:dev", "dev", 1_000);
  let seen = 0;
  const unsub = qc.getQueryCache().subscribe(() => seen++);
  clearRuns(qc);
  unsub();
  expect(qc.getQueryData(liveRunKey("bot:dev"))).toEqual({});
  expect(seen).toBeGreaterThan(0);
});
