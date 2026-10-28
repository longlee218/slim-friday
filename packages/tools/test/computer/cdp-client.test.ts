import { afterEach, expect, test } from "bun:test";
import { CdpClient, rewriteWsUrl } from "../../src/computer/browser/cdp-client";
import { type FakeCdp, startFakeCdp } from "./fake-cdp";

let fake: FakeCdp | undefined;
afterEach(() => fake?.stop());

test("rewrites the guest host:port of the websocket url to the forwarded one", () => {
  expect(rewriteWsUrl("ws://10.9.9.9:1234/devtools/browser/abc", "http://127.0.0.1:5555")).toBe(
    "ws://127.0.0.1:5555/devtools/browser/abc",
  );
});

test("send resolves by id and carries the session id", async () => {
  fake = startFakeCdp((method) => ({ echoed: method }));
  const client = await CdpClient.connect(fake.base);
  const [a, b] = await Promise.all([client.send("A.one"), client.send("B.two", { x: 1 }, "sess")]);
  expect(a).toEqual({ echoed: "A.one" });
  expect(b).toEqual({ echoed: "B.two" });
  expect(fake.messages[1]?.sessionId).toBe("sess");
  client.close();
});

test("send rejects on a CDP error", async () => {
  fake = startFakeCdp(() => ({ error: "no such thing" }));
  const client = await CdpClient.connect(fake.base);
  await expect(client.send("X.y")).rejects.toThrow("no such thing");
  client.close();
});

test("send rejects on timeout", async () => {
  fake = startFakeCdp(() => "never");
  const client = await CdpClient.connect(fake.base, 50);
  await expect(client.send("X.y")).rejects.toThrow("timed out");
  client.close();
});

test("send rejects after close", async () => {
  fake = startFakeCdp(() => ({}));
  const client = await CdpClient.connect(fake.base);
  client.close();
  await expect(client.send("X.y")).rejects.toThrow("closed");
});
