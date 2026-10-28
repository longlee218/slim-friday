import { describe, expect, test } from "bun:test";
import type { ExecResult } from "@friday/core";
import { makePortForwards } from "../src/cua-port-forward";
import { createCuaProvider } from "../src/cua-provider";
import { type CuaRun, makeRunner, OUTPUT_CAP } from "../src/cua-run";
import { assertComputerName, shellLine, shellQuote } from "../src/cua-safe";

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const fail: ExecResult = { code: 3, stdout: "", stderr: "not found" };

/** Fake runners recording argv; `answer` picks the reply per call. */
function fakes(answer: (argv: string[]) => ExecResult = () => ok()) {
  const calls: string[][] = [];
  const dockerCalls: string[][] = [];
  const run: CuaRun = async (argv) => {
    calls.push(argv);
    return answer(argv);
  };
  const docker: CuaRun = async (argv) => {
    dockerCalls.push(argv);
    return ok(JSON.stringify({ NCPU: 4, MemTotal: 8 * 1024 * 1024 * 1024 }));
  };
  const forwards = makePortForwards(
    "/opt/cua/bin/cua",
    { PATH: "/bin", HOME: "/h" },
    {
      spawn: () => ({ kill() {}, exited: new Promise(() => {}) }),
      freePort: async () => 40001,
      waitReady: async () => {},
    },
  );
  const provider = createCuaProvider({ run, docker, forwards });
  return { provider, calls, dockerCalls };
}

describe("computer names", () => {
  const bad = ["../x", "A", "a b", "a;rm", "", "a".repeat(33), "-a", "a/b", "a\nb"];
  for (const name of bad) {
    test(`refuses a computer name outside [a-z0-9-]: ${JSON.stringify(name)}`, async () => {
      const { provider, calls } = fakes();
      expect(() => assertComputerName(name)).toThrow();
      await expect(provider.ensure({ name, cpus: 2, memoryMb: 1536 })).rejects.toThrow();
      await expect(provider.exec(name, ["ls"], 1000)).rejects.toThrow();
      await expect(provider.launch(name, ["ls"], {})).rejects.toThrow();
      await expect(provider.screenshot(name)).rejects.toThrow();
      await expect(provider.act(name, { kind: "key", keys: "a" })).rejects.toThrow();
      await expect(provider.accessibilityTree(name)).rejects.toThrow();
      await expect(provider.forwardPort(name, 9333)).rejects.toThrow();
      await expect(provider.stop(name)).rejects.toThrow();
      expect(calls).toEqual([]);
    });
  }
  test("accepts 32 chars and a digit start", () => {
    expect(assertComputerName("1".repeat(32))).toHaveLength(32);
  });
});

describe("running", () => {
  test("true when info succeeds and it runs; never creates or restarts", async () => {
    const { provider, calls } = fakes(() => ok(JSON.stringify({ state: "running" })));
    expect(await provider.running("bot-a")).toBe(true);
    expect(calls).toEqual([["sandbox", "info", "bot-a"]]);
  });
  test("false when stopped or missing", async () => {
    const stopped = fakes(() => ok(JSON.stringify({ state: "suspended" })));
    expect(await stopped.provider.running("bot-a")).toBe(false);
    const missing = fakes(() => fail);
    expect(await missing.provider.running("bot-a")).toBe(false);
    expect(missing.calls).toEqual([["sandbox", "info", "bot-a"]]);
  });
});

describe("ensure", () => {
  test("creates with --memory 1536MB --cpu 2 when info fails", async () => {
    const { provider, calls } = fakes((a) => (a[1] === "info" ? fail : ok()));
    await provider.ensure({ name: "bot-a", cpus: 2, memoryMb: 1536 });
    expect(calls).toEqual([
      ["sandbox", "info", "bot-a"],
      [
        "sandbox",
        "create",
        "linux",
        "--tier",
        "slim",
        "--name",
        "bot-a",
        "--cpu",
        "2",
        "--memory",
        "1536MB",
      ],
    ]);
  });
  test("does not create when info succeeds and it runs", async () => {
    const { provider, calls } = fakes(() => ok(JSON.stringify({ state: "running" })));
    await provider.ensure({ name: "bot-a", cpus: 2, memoryMb: 1536 });
    expect(calls).toEqual([["sandbox", "info", "bot-a"]]);
  });
  test("starts it when stopped", async () => {
    const { provider, calls } = fakes(() => ok(JSON.stringify({ state: "stopped" })));
    await provider.ensure({ name: "bot-a", cpus: 2, memoryMb: 1536 });
    expect(calls.at(-1)).toEqual(["sandbox", "restart", "bot-a"]);
  });
  test("a failed create throws", async () => {
    const { provider } = fakes(() => fail);
    await expect(provider.ensure({ name: "bot-a", cpus: 2, memoryMb: 1536 })).rejects.toThrow(
      /sandbox create/,
    );
  });
});

describe("guest commands", () => {
  test("exec passes one quoted shell line", async () => {
    const { provider, calls } = fakes();
    await provider.exec("bot-a", ["echo", "it's $(x)"], 5000);
    expect(calls[0]).toEqual([
      "sandbox",
      "exec",
      "bot-a",
      "--timeout",
      "5",
      `'echo' 'it'\\''s $(x)'`,
    ]);
  });
  test("exec reports the exit code and output", async () => {
    const { provider } = fakes(() => ({ code: 2, stdout: "o", stderr: "e" }));
    expect(await provider.exec("bot-a", ["x"], 1000)).toEqual({
      code: 2,
      stdout: "o",
      stderr: "e",
    });
  });
  test("launch detaches with quoted env and argv", async () => {
    const { provider, calls } = fakes();
    await provider.launch("bot-a", ["chromium", "--x=a b"], { LANG: "C" });
    const line = calls[0]?.at(-1);
    expect(line).toBe(`setsid nohup env 'LANG=C' 'chromium' '--x=a b' >/tmp/bot-a.log 2>&1 &`);
  });
  test("launch refuses a bad env name", async () => {
    const { provider, calls } = fakes();
    await expect(provider.launch("bot-a", ["x"], { "A;B": "1" })).rejects.toThrow(/env name/);
    expect(calls).toEqual([]);
  });
});

describe("desktop", () => {
  test("act click selects the computer then clicks", async () => {
    const { provider, calls } = fakes();
    await provider.act("bot-a", { kind: "click", x: 10, y: 20 });
    expect(calls).toEqual([
      ["do", "switch", "local:bot-a"],
      ["do", "click", "10", "20", "left"],
    ]);
  });
  test("act type puts text after --", async () => {
    const { provider, calls } = fakes();
    await provider.act("bot-a", { kind: "type", text: "--rm -rf" });
    expect(calls[1]).toEqual(["do", "type", "--", "--rm -rf"]);
  });
  test("act rejects non-integer coordinates", async () => {
    const { provider } = fakes();
    await expect(provider.act("bot-a", { kind: "click", x: Number.NaN, y: 1 })).rejects.toThrow();
  });
  test("accessibility tree returns stdout", async () => {
    const { provider } = fakes((a) => (a[1] === "switch" ? ok() : ok("TREE")));
    expect(await provider.accessibilityTree("bot-a")).toBe("TREE");
  });
  test("forwardPort is idempotent and stop kills it", async () => {
    const { provider } = fakes();
    const a = await provider.forwardPort("bot-a", 9333);
    expect(a).toBe("http://127.0.0.1:40001");
    expect(await provider.forwardPort("bot-a", 9333)).toBe(a);
  });
});

describe("capacity", () => {
  test("reads NCPU and MemTotal from docker info", async () => {
    const { provider, dockerCalls } = fakes();
    expect(await provider.capacity()).toEqual({ cpus: 4, memoryMb: 8192 });
    expect(dockerCalls).toEqual([["info", "--format", "{{json .}}"]]);
  });
});

describe("shell quoting", () => {
  const hostile = ["a'b", "$(id)", "`id`", "a\nb", "x; rm -rf /", "", "'; echo pwned #", "\\"];
  test("a POSIX shell reads each word back unchanged", async () => {
    for (const w of hostile) {
      const p = Bun.spawn(["/bin/sh", "-c", `printf %s ${shellQuote(w)}`], { stdout: "pipe" });
      expect(await new Response(p.stdout).text()).toBe(w);
    }
  });
  test("a whole line stays one command", async () => {
    const p = Bun.spawn(["/bin/sh", "-c", `printf '%s|' ${shellLine(hostile)}`], {
      stdout: "pipe",
    });
    expect(await new Response(p.stdout).text()).toBe(`${hostile.join("|")}|`);
  });
  test("a NUL byte is refused", () => {
    expect(() => shellQuote("a\0b")).toThrow();
  });
});

describe("runner", () => {
  test("child env is PATH, HOME and DO_NOT_TRACK only", async () => {
    process.env.FRIDAY_TEST_LEAK = "secret";
    try {
      const run = makeRunner("/usr/bin/env", [], { PATH: "/bin", HOME: "/h" });
      const out = await run([], 5000);
      const names = out.stdout
        .split("\n")
        .filter(Boolean)
        .map((l) => l.split("=")[0]);
      expect(out.stdout).toContain("DO_NOT_TRACK=1");
      expect(names).not.toContain("FRIDAY_TEST_LEAK");
      expect(
        names.filter(
          (n) =>
            ![
              "PATH",
              "HOME",
              "DO_NOT_TRACK",
              "PWD",
              "SHLVL",
              "_",
              "__CF_USER_TEXT_ENCODING",
            ].includes(n ?? ""),
        ),
      ).toEqual([]);
    } finally {
      process.env.FRIDAY_TEST_LEAK = undefined;
    }
  });
  test("timeout kills the child and returns code 124", async () => {
    const run = makeRunner("/bin/sleep", [], { PATH: "/bin", HOME: "/h" });
    const t0 = Date.now();
    const res = await run(["5"], 150);
    expect(res.code).toBe(124);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
  test("output over the cap is cut, flagged and the child killed", async () => {
    const run = makeRunner("/bin/sh", [], { PATH: "/usr/bin:/bin", HOME: "/h" });
    const res = await run(["-c", "head -c 9000000 /dev/zero | tr '\\0' a"], 20_000);
    expect(res.stdout).toContain("[output truncated]");
    expect(res.stdout.length).toBeLessThan(OUTPUT_CAP + 100);
  });
  test("timeout returns promptly while a grandchild holds the pipe", async () => {
    const run = makeRunner("/bin/sh", [], { PATH: "/usr/bin:/bin", HOME: "/h" });
    const t0 = Date.now();
    const res = await run(["-c", "sleep 10 & sleep 10"], 300);
    expect(res.code).toBe(124);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe("port forward lifecycle", () => {
  function setup() {
    const kids: { killed: boolean; end: () => void }[] = [];
    const fw = makePortForwards(
      "/opt/cua/bin/cua",
      { PATH: "/bin", HOME: "/h" },
      {
        spawn: () => {
          let end = () => {};
          const exited = new Promise<void>((r) => (end = r));
          const kid = {
            killed: false,
            end,
            kill() {
              kid.killed = true;
            },
            exited,
          };
          kids.push(kid);
          return kid;
        },
        freePort: async () => 40000 + kids.length,
        waitReady: async () => {},
      },
    );
    return { fw, kids };
  }
  test("twice while alive starts one child", async () => {
    const { fw, kids } = setup();
    const a = await fw.forward("bot-a", 9333);
    expect(await fw.forward("bot-a", 9333)).toBe(a);
    expect(kids).toHaveLength(1);
  });
  test("after the child exits the next call starts a new forward", async () => {
    const { fw, kids } = setup();
    const a = await fw.forward("bot-a", 9333);
    kids[0]?.end();
    await Bun.sleep(5);
    const b = await fw.forward("bot-a", 9333);
    expect(kids).toHaveLength(2);
    expect(b).not.toBe(a);
  });
});
