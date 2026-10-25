import { expect, test } from "bun:test";
import { ownerSites, registrableDomain } from "../../src/permission/owner-sites";

test("registrable domain keeps the label before the public suffix", () => {
  expect(registrableDomain("docs.example.com")).toBe("example.com");
  expect(registrableDomain("WWW.Example.COM.")).toBe("example.com");
  expect(registrableDomain("a.b.bbc.co.uk")).toBe("bbc.co.uk");
  expect(registrableDomain("me.github.io")).toBe("me.github.io");
  expect(registrableDomain("x.me.github.io")).toBe("me.github.io");
  expect(registrableDomain("bucket.s3.amazonaws.com")).toBe("bucket.s3.amazonaws.com");
  expect(registrableDomain("10.0.0.1")).toBe("10.0.0.1");
  expect(registrableDomain("localhost")).toBe("localhost");
});

test("owner sites come from URLs and bare hostnames", () => {
  const sites = ownerSites([
    "Read https://docs.bun.sh/api?x=1 and also news.ycombinator.com, please.",
    "Then check (http://foo.github.io/page).",
  ]);
  expect([...sites].sort()).toEqual(["bun.sh", "foo.github.io", "ycombinator.com"]);
});

test("a text with no site gives no site", () => {
  expect(ownerSites(["just do it", ""]).size).toBe(0);
});
