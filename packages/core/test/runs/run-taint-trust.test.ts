import { expect, test } from "bun:test";
import { taintAsk } from "../../src/permission/taint-policy";
import { newRunTaint, onTaintCall, onTaintResult } from "../../src/runs/run-taint";
import { fakeRegistrableDomain as rd } from "../fakes/fake-registrable-domain";

/** Only `tainted` is read once the run is tainted; the store is never reached. */
const exec = () =>
  ({ tainted: true, taint: newRunTaint() }) as never as Parameters<typeof onTaintCall>[0];
const ctx = {} as Parameters<typeof onTaintResult>[0];

test("only the urls of a WebSearch result become trusted fetch targets", async () => {
  const e = exec();
  onTaintCall(e, "s1", "WebSearch");
  onTaintCall(e, "f1", "WebFetch");
  await onTaintResult(ctx, e, "f1", ["https://page.org/injected"]);
  await onTaintResult(ctx, e, "s1", ["https://found.org/a"]);
  const run = {
    tainted: true,
    sites: new Set<string>(),
    approvedSites: new Set<string>(),
    usedMcpServers: new Set<string>(),
    searchUrls: e.taint.searchUrls,
  };
  const fetch = (url: string) => ({ tool: "WebFetch", input: { url } });
  expect(taintAsk(fetch("https://found.org/a"), run, rd)).toBeUndefined();
  expect(taintAsk(fetch("https://page.org/injected"), run, rd)).toBeDefined();
  expect(e.taint.searchCalls.size).toBe(0);
});
