/** Shape of a `Runtime.evaluate` / `callFunctionOn` reply; a page-side throw is `exceptionDetails`, not a CDP error. */
export interface EvalResult<V = unknown> {
  result?: { objectId?: string; value?: V };
  exceptionDetails?: unknown;
}

/** True when the page threw; callers must treat that as a failure, never as success. */
export const thrown = (r: EvalResult): boolean => r.exceptionDetails !== undefined;

/**
 * A step refused before any input reached the page (ref gone, element would not take focus): the page is as the
 * done steps left it, so the bot can fix the step without re-checking the page.
 */
export class SettledStepError extends Error {}

/** One action on the page; refs come from the latest snapshot. */
export type PageStep =
  | { kind: "click"; ref: string }
  | { kind: "type"; ref: string; text: string; submit?: boolean }
  | { kind: "key"; keys: string }
  | { kind: "scroll"; dy: number; ref?: string }
  | { kind: "wait"; ms: number };

/** The page a step runs on: CDP calls bound to its session, the current snapshot generation and world. */
export interface PageHandle {
  send<T = unknown>(method: string, params?: object): Promise<T>;
  readonly gen: number;
  readonly contextId: number | undefined;
  sleep(ms: number): Promise<void>;
}

/** Most steps one `act` call runs. */
export const MAX_STEPS = 20;
/** Longest single `wait` step. */
export const MAX_WAIT_MS = 10_000;

const REF = /^p(\d+):(\d+)$/;
const KEY_CODES: Record<string, number> = {
  Enter: 13,
  Tab: 9,
  Escape: 27,
  Backspace: 8,
  Delete: 46,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
};
const MODIFIERS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

const refOf = (step: PageStep): string | undefined =>
  step.kind === "click" || step.kind === "type" || (step.kind === "scroll" && step.ref)
    ? (step as { ref?: string }).ref
    : undefined;

/** Refuse the whole call (nothing runs) on too many steps, a malformed ref, or a ref of another snapshot. */
export function validateSteps(steps: PageStep[], gen: number): void {
  if (steps.length === 0) throw new Error("steps is empty");
  if (steps.length > MAX_STEPS)
    throw new Error(`at most ${MAX_STEPS} steps per call, got ${steps.length}`);
  for (const step of steps) {
    const ref = refOf(step);
    if (ref === undefined) continue;
    const m = REF.exec(ref);
    if (!m)
      throw new Error(`ref ${JSON.stringify(ref)} is malformed; use p<n>:<i> from BrowserSnapshot`);
    const g = Number(m[1]);
    if (g < gen)
      throw new Error(`ref ${ref} is from an older snapshot; call BrowserSnapshot again`);
    if (g > gen)
      throw new Error(`ref ${ref} is not from a snapshot taken here; call BrowserSnapshot again`);
  }
}

/**
 * Run steps in order; stops at the first failure. A `SettledStepError` reports `uncertain: false` (the step did not
 * run); any other failure is `uncertain: true` (an input may have reached the page, its state is unknown).
 * `beforeStep` runs before each step (after the whole batch is validated); if it throws, the error names the steps done.
 */
export async function runSteps(
  page: PageHandle,
  steps: PageStep[],
  beforeStep?: () => Promise<void>,
): Promise<string> {
  validateSteps(steps, page.gen);
  const lines: string[] = [];
  for (const [n, step] of steps.entries()) {
    try {
      await beforeStep?.();
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      throw new Error(`${why} after ${n} of ${steps.length} steps`);
    }
    try {
      await runStep(page, step);
      lines.push(`ok ${n + 1}. ${describe(step)}`);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      lines.push(`failed ${n + 1}. ${describe(step)}: ${why}`);
      lines.push(
        err instanceof SettledStepError
          ? `done ${n} of ${steps.length}; uncertain: false (step ${n + 1} did not run; the page is as the done steps left it)`
          : `done ${n} of ${steps.length}; uncertain: true (page state unknown, call BrowserSnapshot again)`,
      );
      return lines.join("\n");
    }
  }
  lines.push(`done ${steps.length} of ${steps.length}`);
  return lines.join("\n");
}

const describe = (s: PageStep): string =>
  s.kind === "type" ? `type ${s.ref}` : s.kind === "click" ? `click ${s.ref}` : s.kind;

async function runStep(page: PageHandle, step: PageStep): Promise<void> {
  switch (step.kind) {
    case "wait":
      return page.sleep(Math.max(0, Math.min(step.ms, MAX_WAIT_MS)));
    case "key":
      return pressKeys(page, step.keys);
    case "click": {
      const [x, y] = await centreOf(page, step.ref);
      await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      for (const type of ["mousePressed", "mouseReleased"])
        await page.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
      return;
    }
    case "scroll": {
      const [x, y] = step.ref ? await centreOf(page, step.ref) : [200, 200];
      return void (await page.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x,
        y,
        deltaX: 0,
        deltaY: step.dy,
      }));
    }
    case "type": {
      const objectId = await resolve(page, step.ref);
      const focus = await page.send<EvalResult<boolean>>("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration:
          "function(){this.focus();return document.activeElement===this||this.contains(document.activeElement)}",
        returnByValue: true,
      });
      if (thrown(focus) || focus.result?.value !== true)
        throw new SettledStepError(`${step.ref} could not take focus; nothing was typed`);
      // UNVERIFIED: confirm with the live check (Input.insertText into the focused element).
      await page.send("Input.insertText", { text: step.text });
      if (step.submit) await pressKeys(page, "Enter");
    }
  }
}

/** Object id of the element behind a ref, looked up in the page-side Map of the isolated world. */
async function resolve(page: PageHandle, ref: string): Promise<string> {
  const [, g, i] = REF.exec(ref) ?? [];
  if (page.contextId === undefined)
    throw new SettledStepError("no snapshot taken; call BrowserSnapshot first");
  // UNVERIFIED: confirm with the live check (isolated-world lookup by contextId, objectId reuse).
  const r = await page.send<EvalResult>("Runtime.evaluate", {
    expression: `(globalThis.__fridayRefs?.get(${Number(g)}) ?? [])[${Number(i)}]`,
    contextId: page.contextId,
  });
  if (thrown(r) || !r.result?.objectId)
    throw new SettledStepError(`ref ${ref} is gone from the page; call BrowserSnapshot again`);
  return r.result.objectId;
}

/** Scroll the element into view and return the centre of its box. */
async function centreOf(page: PageHandle, ref: string): Promise<[number, number]> {
  const objectId = await resolve(page, ref);
  // UNVERIFIED: confirm with the live check (DOM.scrollIntoViewIfNeeded / DOM.getBoxModel without DOM.enable).
  await page.send("DOM.scrollIntoViewIfNeeded", { objectId });
  const { model } = await page.send<{ model: { content: number[] } }>("DOM.getBoxModel", {
    objectId,
  });
  const xs = model.content.filter((_, k) => k % 2 === 0);
  const ys = model.content.filter((_, k) => k % 2 === 1);
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  return [mean(xs), mean(ys)];
}

/** `Control+a`, `Enter`, `Tab`, a single character... modifiers first, key last. */
async function pressKeys(page: PageHandle, keys: string): Promise<void> {
  const parts = keys.split("+");
  const key = parts.pop() ?? "";
  if (!key) throw new Error("empty key");
  const modifiers = parts.reduce((acc, m) => acc | (MODIFIERS[m] ?? 0), 0);
  const code = KEY_CODES[key];
  const text = key === "Enter" ? "\r" : key.length === 1 && !(modifiers & 6) ? key : undefined;
  const base = { key, modifiers, ...(code && { windowsVirtualKeyCode: code }) };
  await page.send("Input.dispatchKeyEvent", {
    ...base,
    type: text ? "keyDown" : "rawKeyDown",
    ...(text && { text }),
  });
  await page.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}
