import type { ComputerProvider } from "@friday/core";
import { validateSessionInput } from "./browser-session-input";
import { CdpClient } from "./cdp-client";
import { type EvalResult, type PageHandle, type PageStep, runSteps, thrown } from "./page-act";
import { formatSnapshot, type RawSnapshot } from "./page-snapshot";
import { PAGE_SNAPSHOT_SCRIPT } from "./page-snapshot-script";

/** Chromium executable inside the computer. UNVERIFIED: confirm in the live check (name in the Cua Linux image). */
export const CHROMIUM_BIN = "chromium";

const ATTACH_TRIES = 20;
const ATTACH_WAIT_MS = 500;
const LOAD_POLLS = 40;
const LOAD_POLL_MS = 250;

/** What a bot's browser needs; `sleep` is injectable so tests do not wait. */
export interface BrowserSessionDeps {
  provider: ComputerProvider;
  computer: string;
  botId: string;
  cdpPort: number;
  profileRoot: string;
  sleep?: (ms: number) => Promise<void>;
  /** Clock for the starting snapshot generation (tests). */
  now?: () => number;
}

/** One bot's persistent Chromium in its computer, driven over raw CDP through the provider port-forward. */
export class BrowserSession {
  private client: CdpClient | undefined;
  private sessionId = "";
  private contextId: number | undefined;
  private gen: number;
  private readonly sleep: (ms: number) => Promise<void>;

  /** Validates every field that reaches an argv or a path, before anything runs; the error names the field. */
  constructor(private readonly d: BrowserSessionDeps) {
    validateSessionInput(d);
    // Time-based start: a new instance or engine restart never reuses a generation an old ref may carry.
    this.gen = Math.floor((d.now ?? Date.now)() / 1000) % 1_000_000;
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Attach to the running browser, or start Chromium in the computer and attach once it answers. */
  async ensure(): Promise<void> {
    if (this.client?.open) return;
    this.reset();
    try {
      await this.attach();
      return;
    } catch {
      // not running yet: launch below
    }
    const { botId, cdpPort, profileRoot } = this.d;
    await this.d.provider.launch(
      this.d.computer,
      [
        CHROMIUM_BIN,
        `--user-data-dir=${profileRoot}/${botId}`,
        `--remote-debugging-port=${cdpPort}`,
        // UNVERIFIED: confirm with the live check (flag honoured by the image's chromium).
        "--remote-debugging-address=127.0.0.1",
        "--no-first-run",
        "about:blank",
      ],
      {},
    );
    let last = "";
    for (let i = 0; i < ATTACH_TRIES; i++) {
      try {
        await this.attach();
        return;
      } catch (err) {
        last = err instanceof Error ? err.message : String(err);
        await this.sleep(ATTACH_WAIT_MS);
      }
    }
    throw new Error(`browser did not start in the computer (${last}); try again`);
  }

  /** Open an http(s) or about:blank page and return its snapshot; any other scheme is refused before CDP. */
  async navigate(url: string): Promise<string> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`url ${JSON.stringify(url)} is not a valid url`);
    }
    if (!["http:", "https:"].includes(parsed.protocol) && url !== "about:blank")
      throw new Error(
        `url scheme ${parsed.protocol} is not allowed; use http, https or about:blank`,
      );
    await this.ensure();
    const nav = await this.page().send<{ errorText?: string }>("Page.navigate", { url });
    if (nav.errorText) throw new Error(`navigation failed: ${nav.errorText}`);
    this.contextId = undefined;
    for (let i = 0; i < LOAD_POLLS; i++) {
      const r = await this.page().send<EvalResult<string>>("Runtime.evaluate", {
        expression: "document.readyState",
        returnByValue: true,
      });
      if (!thrown(r) && r.result?.value === "complete") break;
      await this.sleep(LOAD_POLL_MS);
    }
    return this.snapshot();
  }

  /** New snapshot generation of the current page; earlier refs stop working. */
  async snapshot(): Promise<string> {
    await this.ensure();
    const page = this.page();
    const gen = this.gen + 1;
    const tree = await page.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree");
    const world = await page.send<{ executionContextId: number }>("Page.createIsolatedWorld", {
      frameId: tree.frameTree.frame.id,
      worldName: "friday",
    });
    const r = await page.send<EvalResult<RawSnapshot>>("Runtime.evaluate", {
      expression: `(${PAGE_SNAPSHOT_SCRIPT})(${gen})`,
      contextId: world.executionContextId,
      returnByValue: true,
    });
    if (thrown(r) || !r.result?.value)
      throw new Error("page snapshot failed; the page may be loading, try again");
    this.gen = gen;
    this.contextId = world.executionContextId;
    return formatSnapshot(r.result.value, gen);
  }

  /** Run up to 20 steps on the page; refs must come from the latest snapshot. */
  async act(steps: PageStep[]): Promise<string> {
    await this.ensure();
    return runSteps(this.page(), steps);
  }

  /** Graceful stop: `Browser.close` so cookies flush (never a kill), then drop the connection. Idempotent. */
  async close(): Promise<void> {
    const client = this.client;
    this.reset();
    if (!client?.open) return;
    try {
      await client.send("Browser.close");
    } catch {
      // the browser may drop the socket while closing
    }
    client.close();
  }

  private async attach(): Promise<void> {
    const base = await this.d.provider.forwardPort(this.d.computer, this.d.cdpPort);
    const client = await CdpClient.connect(base);
    try {
      const { targetInfos } = await client.send<{
        targetInfos: { targetId: string; type: string }[];
      }>("Target.getTargets");
      const target = targetInfos.find((t) => t.type === "page");
      if (!target) throw new Error("no page target in the browser");
      const { sessionId } = await client.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: true,
      });
      this.client = client;
      this.sessionId = sessionId;
    } catch (err) {
      client.close();
      throw err;
    }
  }

  private reset(): void {
    this.client = undefined;
    this.sessionId = "";
    this.contextId = undefined;
    // `gen` is never reset: an old ref must stay stale after a reconnect.
  }

  private page(): PageHandle {
    const client = this.client;
    if (!client) throw new Error("browser is not attached");
    const self = this;
    return {
      send: (method, params) => client.send(method, params, self.sessionId),
      get gen() {
        return self.gen;
      },
      get contextId() {
        return self.contextId;
      },
      sleep: this.sleep,
    };
  }
}
