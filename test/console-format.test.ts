import { expect, test } from "bun:test";
import { Writable } from "node:stream";
import pino from "pino";
import pretty from "pino-pretty";
import { consoleMessage } from "../src/observability/console-format";
import { consolePrettyOptions } from "../src/observability/logger";

const ctx = { taskId: "8f3a1c2e-1111-2222", workspace: "reelme", repo: "reelme-v2", mode: "qa" };

test("tool.done renders compactly with the task suffix", () => {
  const msg = consoleMessage({
    event: "tool.done",
    tool: "Read",
    target: "src/a.ts:70-159",
    ok: true,
    durationMs: 1,
    lines: 90,
    chars: 3800,
    ...ctx,
  });
  expect(msg).toBe(
    "tool.done Read src/a.ts:70-159 ok 1ms 90 lines 3.7KB  · 8f3a1c2e reelme/reelme-v2 qa",
  );
});

test("tool.done failed shows FAILED and the error; tool.denied shows the reason", () => {
  expect(
    consoleMessage({
      event: "tool.done",
      tool: "Bash",
      target: "ls",
      ok: false,
      durationMs: 4,
      err: "boom",
    }),
  ).toBe('tool.done Bash ls FAILED 4ms err="boom"');
  expect(
    consoleMessage({ event: "tool.denied", tool: "Read", target: "…/.env", reason: "secret file" }),
  ).toBe("tool.denied Read …/.env DENIED secret file");
});

test("thread/channel only on task.started and message.received", () => {
  const base = { threadId: "T1", channelId: "C1", ...ctx };
  expect(consoleMessage({ event: "task.started", msg: "task.started", ...base })).toContain(
    "thread=T1 channel=C1",
  );
  expect(consoleMessage({ event: "run.started", msg: "run.started", ...base })).not.toContain("T1");
});

test("other events keep message and ALL their own fields (printed by pretty, not hidden)", () => {
  const l: Record<string, unknown> = {
    msg: "warned",
    err: "boom",
    durationMs: 5,
    files: 2,
    ok: true,
  };
  expect(consoleMessage(l)).toBe("warned err=boom");
  expect(l).toMatchObject({ durationMs: 5, files: 2, ok: true });
});

test("a long line is clipped to 200 chars (+ suffix)", () => {
  const msg = consoleMessage({ event: "tool.start", tool: "Bash", target: "x".repeat(500) });
  expect(msg.length).toBeLessThanOrEqual(200);
});

test("real in-process pino-pretty stream: one short line, ignored fields hidden, no extra JSON", () => {
  let out = "";
  const stream = pretty({
    ...consolePrettyOptions(),
    colorize: false,
    destination: new Writable({
      write(chunk, _enc, cb) {
        out += String(chunk);
        cb();
      },
    }),
  });
  const log = pino({}, stream);
  log.info(
    {
      event: "tool.done",
      tool: "Read",
      toolUseId: "u1",
      target: "a.ts",
      ok: true,
      durationMs: 1,
      input: "{...}",
      ...ctx,
    },
    "tool.done",
  );
  expect(out.trim().split("\n").length).toBe(1);
  expect(out).toContain("tool.done Read a.ts ok 1ms");
  expect(out).not.toContain("{");
  expect(out).not.toContain("u1");
  expect(out).not.toContain("{...}");
});

/** Render records through a real in-process pino-pretty stream; returns the printed lines. */
function render(records: [Record<string, unknown>, string, ("info" | "warn")?][]): string[] {
  let out = "";
  const stream = pretty({
    ...consolePrettyOptions(),
    colorize: false,
    destination: new Writable({
      write(chunk, _enc, cb) {
        out += String(chunk);
        cb();
      },
    }),
  });
  const log = pino({}, stream);
  for (const [fields, msg, level] of records) log[level ?? "info"](fields, msg);
  return out.trim().split("\n");
}

const inCtx = {
  taskId: "8f3a1c2e-1111-2222",
  workspace: "ws",
  repo: "r",
  mode: "qa",
  threadId: "T1",
};

test("pretty stream, non-tool events keep their fields (review M1)", () => {
  const [plugin, git, ignored, resume, orphan, pr] = render([
    [
      { event: "skills.plugin_built", files: 7, skills: 2, bytes: 99, ...inCtx },
      "skills.plugin_built",
    ],
    [{ event: "git.call", tool: "git_log", ms: 5, ok: false, err: "bad", ...inCtx }, "git.call"],
    [{ event: "message.ignored", reason: "no_parent_channel", threadId: "T9" }, "message.ignored"],
    [{ threadId: "T7", err: "send failed" }, "resume notice failed", "warn"],
    [{ event: "worktree.orphan", taskId: "FULL-TASK-ID-0123456789" }, "worktree.orphan"],
    [{ event: "pr.created", repo: "api", url: "u" }, "pr.created"],
  ]);
  expect(plugin).toContain('"files":7');
  expect(plugin).toContain("· 8f3a1c2e ws/r qa");
  expect(plugin).not.toContain("T1"); // plain info event: no thread
  expect(git).toContain('"ok":false');
  expect(git).toContain("err=bad");
  expect(ignored).toContain("thread=T9");
  expect(ignored).toContain('"reason":"no_parent_channel"');
  expect(resume).toContain("thread=T7");
  expect(resume).toContain("err=send failed");
  expect(orphan).toContain("taskId=FULL-TASK-ID-0123456789");
  expect(pr).toContain("repo=api");
});

test("Read-shaped tool.done shows exact size, approx size shows ~", () => {
  expect(
    consoleMessage({
      event: "tool.done",
      tool: "Read",
      target: "a",
      ok: true,
      durationMs: 1,
      chars: 2048,
    }),
  ).toContain(" 2.0KB");
  expect(
    consoleMessage({
      event: "tool.done",
      tool: "X",
      target: "",
      ok: true,
      durationMs: 1,
      chars: 2048,
      approx: true,
    }),
  ).toContain("~2.0KB");
});
