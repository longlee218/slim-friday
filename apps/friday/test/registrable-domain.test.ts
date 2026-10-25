import { expect, test } from "bun:test";
import { ownerSites, taintAsk } from "@friday/core";
import { registrableDomain as rd } from "../src/registrable-domain";

const fetch = (url: string) => ({ tool: "WebFetch", input: { url } });
const tainted = (sites: string[]) => ({
  tainted: true,
  sites: new Set(sites),
  approvedSites: new Set<string>(),
  usedMcpServers: new Set<string>(),
});

test("shared hosts of the private section are separate sites", () => {
  expect(rd("myapp.fly.dev")).toBe("myapp.fly.dev");
  expect(rd("evil.fly.dev")).toBe("evil.fly.dev");
  expect(rd("a.me.github.io")).toBe("me.github.io");
  expect(rd("x.s3.us-west-2.amazonaws.com")).toBe("x.s3.us-west-2.amazonaws.com");
  expect(rd("docs.bbc.co.uk")).toBe("bbc.co.uk");
});

test("a public suffix, an unknown suffix or localhost is no site; an IP is kept", () => {
  expect(rd("s3.amazonaws.com")).toBeUndefined();
  expect(rd("fly.dev")).toBeUndefined();
  expect(rd("github.io")).toBeUndefined();
  expect(rd("localhost")).toBeUndefined();
  expect(rd("a.b.unknownzz")).toBeUndefined();
  expect(rd("10.0.0.1")).toBe("10.0.0.1");
});

test("taint policy with the real list: owner's fly.dev app passes, another fly.dev app asks", () => {
  const sites = [...ownerSites(["deploy to https://myapp.fly.dev and check me.github.io"], rd)];
  expect(sites.sort()).toEqual(["me.github.io", "myapp.fly.dev"]);
  const run = tainted(sites);
  expect(taintAsk(fetch("https://myapp.fly.dev/health"), run, rd)).toBeUndefined();
  expect(taintAsk(fetch("https://evil.fly.dev/"), run, rd)).toBeDefined();
  expect(taintAsk(fetch("https://other.github.io/"), run, rd)).toBeDefined();
  expect(taintAsk(fetch("https://s3.amazonaws.com/bucket/x"), run, rd)).toBeDefined();
  expect(ownerSites(["fix README.md and main.cc, run setup.sh"], rd).size).toBe(0);
});
