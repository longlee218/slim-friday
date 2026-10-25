import { expect, test } from "bun:test";
import { exactHost, ownerSites } from "../../src/permission/owner-sites";
import { fakeRegistrableDomain as rd } from "../fakes/fake-registrable-domain";

const sites = (...texts: string[]) => [...ownerSites(texts, rd)].sort();

test("owner sites come from URLs and bare hostnames, by registrable domain", () => {
  expect(
    sites(
      "Read https://docs.bun.sh/api?x=1 and also news.example.com, please.",
      "Then check (http://foo.github.io/page) and myapp.fly.dev.",
    ),
  ).toEqual(["bun.sh", "example.com", "foo.github.io", "myapp.fly.dev"]);
});

test("file names are never sites", () => {
  expect(sites("fix README.md and main.cc, run setup.sh")).toEqual([]);
  expect(sites("edit app.ts, config.json, notes.txt and ci.yaml")).toEqual([]);
});

test("more file names are never sites", () => {
  expect(sites("see main.tf, build.mk, lib.ml, logo.ai, App.java, id.pub and app.pro")).toEqual([]);
});

test("a bare non-ASCII host is one host in punycode, never its ASCII tail", () => {
  expect(sites("buy at bücher.de today")).toEqual(["xn--bcher-kva.de"]);
  expect(sites("open https://bücher.de/x")).toEqual(["xn--bcher-kva.de"]);
  expect(sites("not_a.de or x-.de")).toEqual([]);
});

test("a full URL with a file-like TLD still counts", () => {
  expect(sites("see https://get.example.sh/install")).toEqual(["example.sh"]);
});

test("a host inside a URL's path or query is not a site", () => {
  expect(sites("open https://example.com/r?to=attacker.com&b=x.evil.com/y")).toEqual([
    "example.com",
  ]);
});

test("a public suffix or an unknown suffix is never a site", () => {
  expect(sites("https://fly.dev/x and github.io", "localhost and a.b.unknownzz")).toEqual([]);
});

test("without a list, the exact host is the site", () => {
  expect([...ownerSites(["https://Docs.Example.com./a"])]).toEqual(["docs.example.com"]);
  expect(exactHost("A.B.")).toBe("a.b");
});

test("a text with no site gives no site", () => {
  expect(sites("just do it", "")).toEqual([]);
});
