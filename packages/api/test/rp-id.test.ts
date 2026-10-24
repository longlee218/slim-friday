import { expect, test } from "bun:test";
import { rpIdFor } from "../src/auth/rp-id";

test("drops the first label of a host with three or more labels", () => {
  expect(rpIdFor("https://friday.example.com")).toBe("example.com");
  expect(rpIdFor("https://a.b.example.co.uk")).toBe("b.example.co.uk");
});

test("keeps a two-label host, localhost and IPs", () => {
  expect(rpIdFor("https://example.com")).toBe("example.com");
  expect(rpIdFor("http://localhost:5173")).toBe("localhost");
  expect(rpIdFor("http://127.0.0.1:5173")).toBe("127.0.0.1");
});
