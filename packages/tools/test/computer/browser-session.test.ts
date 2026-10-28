import { afterEach, describe, expect, test } from "bun:test";
import type { ComputerProvider } from "@friday/core";
import { BrowserSession, CHROMIUM_BIN } from "../../src/computer/browser/browser-session";
import { type CdpHandler, type FakeCdp, startFakeCdp } from "./fake-cdp";

const RAW = {
  url: "https://example.com/",
  title: "Example",
  text: "hi",
  elements: [{ i: 0, role: "button", name: "Go" }],
};

/** A browser that answers every call the session makes; `missing` makes element lookups fail. */
function browser(
  opts: { missing?: boolean; focus?: boolean | "throw"; snapshotThrows?: boolean } = {},
): CdpHandler {
  return (method, params) => {
    switch (method) {
      case "Target.getTargets":
        return { targetInfos: [{ targetId: "t1", type: "page" }] };
      case "Target.attachToTarget":
        return { sessionId: "s1" };
      case "Page.getFrameTree":
        return { frameTree: { frame: { id: "f1" } } };
      case "Page.createIsolatedWorld":
        return { executionContextId: 7 };
      case "Runtime.evaluate": {
        const expr = String(params.expression);
        if (expr.startsWith("(globalThis.__fridayRefs"))
          return opts.missing ? { result: { type: "undefined" } } : { result: { objectId: "o1" } };
        if (expr.includes("readyState")) return { result: { value: "complete" } };
        if (opts.snapshotThrows) return { result: {}, exceptionDetails: { text: "boom" } };
        return { result: { value: RAW } };
      }
      case "Runtime.callFunctionOn":
        return opts.focus === "throw"
          ? { result: {}, exceptionDetails: { text: "TypeError" } }
          : { result: { value: opts.focus ?? true } };
      case "DOM.getBoxModel":
        return { model: { content: [10, 10, 30, 10, 30, 30, 10, 30] } };
      case "Page.navigate":
        return { frameId: "f1" };
      default:
        return {};
    }
  };
}

interface Rig {
  fake: FakeCdp;
  launched: { name: string; argv: string[]; env: Record<string, string> }[];
  session: BrowserSession;
}

let fakes: FakeCdp[] = [];
afterEach(() => {
  for (const f of fakes) f.stop();
  fakes = [];
});

/** Session over a fake provider; `down` = the endpoint only answers after `launch`. */
function rig(opts: { down?: boolean; handler?: CdpHandler; now?: number } = {}): Rig {
  const fake = startFakeCdp(opts.handler ?? browser());
  fakes.push(fake);
  const launched: Rig["launched"] = [];
  const provider = {
    launch: async (name: string, argv: string[], env: Record<string, string>) => {
      launched.push({ name, argv, env });
    },
    forwardPort: async () => {
      if (opts.down && launched.length === 0) throw new Error("forward failed");
      return fake.base;
    },
  } as unknown as ComputerProvider;
  const session = new BrowserSession({
    provider,
    computer: "ann-pc",
    botId: "ann",
    cdpPort: 9222,
    profileRoot: "/home/user/profiles",
    sleep: async () => {},
    now: () => opts.now ?? 0,
  });
  return { fake, launched, session };
}

const methods = (r: Rig) => r.fake.messages.map((m) => m.method);

describe("constructor", () => {
  const ok = { computer: "ann-pc", botId: "ann", cdpPort: 9222, profileRoot: "/p" };
  const make = (over: Record<string, unknown>) =>
    new BrowserSession({ provider: {} as ComputerProvider, ...ok, ...over });
  test.each([
    ["botId", { botId: "../x" }],
    ["botId", { botId: "a b" }],
    ["botId", { botId: "-rf" }],
    ["botId", { botId: "a=b" }],
    ["botId", { botId: "a/b" }],
    ["computer", { computer: "a;b" }],
    ["computer", { computer: "../x" }],
    ["computer", { computer: "A" }],
    ["cdpPort", { cdpPort: 80 }],
    ["cdpPort", { cdpPort: 70000 }],
    ["cdpPort", { cdpPort: 9222.5 }],
    ["profileRoot", { profileRoot: "relative/dir" }],
    ["profileRoot", { profileRoot: "/a/../b" }],
    ["profileRoot", { profileRoot: "/a\nb" }],
  ])("refuses a hostile %s", (field, over) => {
    expect(() => make(over)).toThrow(field);
  });
});

describe("ensure", () => {
  test("launches chromium with the exact argv when the endpoint is down", async () => {
    const r = rig({ down: true });
    await r.session.ensure();
    expect(r.launched).toHaveLength(1);
    expect(r.launched[0]?.name).toBe("ann-pc");
    expect(r.launched[0]?.argv).toEqual([
      CHROMIUM_BIN,
      "--user-data-dir=/home/user/profiles/ann",
      "--remote-debugging-port=9222",
      "--remote-debugging-address=127.0.0.1",
      "--no-first-run",
      "about:blank",
    ]);
    expect(methods(r)).toContain("Target.attachToTarget");
  });

  test("does not launch when the endpoint is up", async () => {
    const r = rig();
    await r.session.ensure();
    expect(r.launched).toHaveLength(0);
  });

  test("throws a readable error when the browser never comes up", async () => {
    const provider = {
      launch: async () => {},
      forwardPort: async () => {
        throw new Error("nope");
      },
    } as unknown as ComputerProvider;
    const s = new BrowserSession({
      provider,
      computer: "c",
      botId: "ann",
      cdpPort: 9222,
      profileRoot: "/p",
      sleep: async () => {},
    });
    await expect(s.ensure()).rejects.toThrow("browser did not start");
  });
});

describe("navigate", () => {
  test.each([
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,x",
    "chrome://settings",
    "view-source:http://a",
    "",
    "not a url",
  ])("navigate refuses a non http/https/about url: %p", async (url) => {
    const r = rig();
    await expect(r.session.navigate(url)).rejects.toThrow();
    expect(r.fake.messages).toHaveLength(0);
  });

  test("opens an https page and returns its snapshot", async () => {
    const r = rig();
    const out = await r.session.navigate("https://example.com/");
    expect(methods(r)).toContain("Page.navigate");
    expect(out).toContain('[p1:0] button "Go"');
  });
});

describe("act", () => {
  test("clicks the centre of the element box", async () => {
    const r = rig();
    await r.session.snapshot();
    const out = await r.session.act([{ kind: "click", ref: "p1:0" }]);
    expect(out).toContain("ok");
    const pressed = r.fake.messages.find(
      (m) => m.method === "Input.dispatchMouseEvent" && m.params.type === "mousePressed",
    );
    expect(pressed?.params).toMatchObject({ x: 20, y: 20 });
  });

  test("act on a ref from an older snapshot is refused", async () => {
    const r = rig();
    await r.session.snapshot();
    await r.session.snapshot();
    await r.session.snapshot();
    const before = r.fake.messages.length;
    await expect(r.session.act([{ kind: "click", ref: "p2:4" }])).rejects.toThrow(
      "ref p2:4 is from an older snapshot; call BrowserSnapshot again",
    );
    expect(r.fake.messages.length).toBe(before);
  });

  test("refuses a malformed ref and more than 20 steps", async () => {
    const r = rig();
    await r.session.snapshot();
    await expect(r.session.act([{ kind: "click", ref: "button" }])).rejects.toThrow("ref");
    const many = Array.from({ length: 21 }, () => ({ kind: "key" as const, keys: "Tab" }));
    await expect(r.session.act(many)).rejects.toThrow("20");
  });

  test("stops at the first failing step and reports uncertain", async () => {
    const r = rig({ handler: browser({ missing: true }) });
    await r.session.snapshot();
    const out = await r.session.act([
      { kind: "key", keys: "Tab" },
      { kind: "click", ref: "p1:0" },
      { kind: "key", keys: "Enter" },
    ]);
    expect(out).toContain("done 1");
    expect(out).toContain("failed 2");
    expect(out).toContain("uncertain: true");
    expect(out).not.toContain("3.");
  });

  test("types with focus and insertText, then submits with Enter", async () => {
    const r = rig();
    await r.session.snapshot();
    await r.session.act([{ kind: "type", ref: "p1:0", text: "hello", submit: true }]);
    expect(methods(r)).toContain("Runtime.callFunctionOn");
    expect(r.fake.messages.find((m) => m.method === "Input.insertText")?.params.text).toBe("hello");
    expect(
      r.fake.messages.some(
        (m) => m.method === "Input.dispatchKeyEvent" && m.params.key === "Enter",
      ),
    ).toBe(true);
  });
});

describe("type safety", () => {
  const typeStep = [{ kind: "type" as const, ref: "p1:0", text: "secret text", submit: true }];

  test("does not insert text when the element cannot take focus", async () => {
    const r = rig({ handler: browser({ focus: false }) });
    await r.session.snapshot();
    const out = await r.session.act(typeStep);
    expect(out).toContain("failed 1");
    expect(out).toContain("uncertain: true");
    expect(methods(r)).not.toContain("Input.insertText");
    expect(methods(r)).not.toContain("Input.dispatchKeyEvent");
  });

  test("a page-side throw during focus is a failure", async () => {
    const r = rig({ handler: browser({ focus: "throw" }) });
    await r.session.snapshot();
    const out = await r.session.act(typeStep);
    expect(out).toContain("failed 1");
    expect(methods(r)).not.toContain("Input.insertText");
  });

  test("a page-side throw while snapshotting is a failure", async () => {
    const r = rig({ handler: browser({ snapshotThrows: true }) });
    await expect(r.session.snapshot()).rejects.toThrow("snapshot failed");
  });
});

describe("generation", () => {
  const gen = (s: string) => Number(/\[p(\d+):/.exec(s)?.[1]);

  test("stays monotonic after a dropped socket and the old ref is refused", async () => {
    const r = rig({ now: 5000 });
    const first = gen(await r.session.snapshot());
    r.fake.dropConnections();
    await Bun.sleep(50);
    const second = gen(await r.session.snapshot());
    expect(second).toBeGreaterThan(first);
    await expect(r.session.act([{ kind: "click", ref: `p${first}:0` }])).rejects.toThrow(
      `ref p${first}:0 is from an older snapshot; call BrowserSnapshot again`,
    );
  });

  test("sessions created at different instants start at different generations", async () => {
    const a = gen(await rig({ now: 5_000 }).session.snapshot());
    const b = gen(await rig({ now: 9_000 }).session.snapshot());
    expect(a).not.toBe(b);
  });
});

describe("close", () => {
  test("sends Browser.close, never kills, and is idempotent", async () => {
    const r = rig();
    await r.session.ensure();
    await r.session.close();
    await r.session.close();
    expect(methods(r).filter((m) => m === "Browser.close")).toHaveLength(1);
  });

  test("is safe when never started", async () => {
    await rig().session.close();
  });
});
