import type { ComputerSettings } from "@friday/config";
import {
  type Bot,
  type BotId,
  type BotRuntimeSpec,
  type Clock,
  type ComputerProvider,
  type ComputerProviderPlugin,
  type Log,
  releaseSlot,
  type Store,
} from "@friday/core";
import { BrowserSession, computerServer } from "@friday/tools";
import { computerProvider, computerSlots } from "./computer-plugins";

/** Where each bot's Chromium profile lives inside its computer (`<root>/<botId>`). */
export const PROFILE_ROOT = "/home/cua/friday-profiles";
/** The first bot of a computer debugs its Chromium on this port; the next bots take the following ones. */
export const CDP_BASE_PORT = 9300;
/** Size of a computer when settings.yaml does not set it. */
const DEFAULT_CPUS = 2;
const DEFAULT_MEMORY_MB = 1536;

/**
 * The cdp port of a bot's Chromium: 9300 plus the bot's index among the sorted ids of the bots that share its
 * computer, so two bots on one computer never meet on one port.
 */
export function cdpPortOf(botId: BotId, computer: string, bots: Bot[]): number {
  const ids = bots
    .filter((b) => b.computer === computer)
    .map((b) => b.id)
    .sort();
  return CDP_BASE_PORT + Math.max(0, ids.indexOf(botId));
}

/** What the computers of this process are built from. */
export interface ComputersDeps {
  settings: ComputerSettings | undefined;
  /** The owner's env: only PATH and HOME reach the provider plugin. */
  env: Record<string, string | undefined>;
  /** Every loaded bot (read when a session is built). */
  bots: () => Bot[];
  holds: Store["computerHolds"];
  clock: Clock;
  log: Pick<Log, "warn" | "info">;
  sleep?: (ms: number) => Promise<void>;
  plugins?: ComputerProviderPlugin[];
}

/** The computers of one process: the provider, the slots, a browser per bot and the run-end release. */
export interface Computers {
  /** Slots this machine allows at once (0 until computed, or when there is no provider). */
  slotLimit(): number;
  /** Readable slot line (or why there is none), for the `<computer>` facts and the tools' refusals. */
  slotsText(): string;
  /** Settles once the slots were computed at start (never rejects). */
  ready: Promise<void>;
  /** Where a bot's browser lives in its computer. */
  placement(bot: Bot): { cdpPort: number; profileDir: string };
  /** The `computer` server of a session; undefined for a bot without a computer. */
  server(spec: BotRuntimeSpec): ReturnType<typeof computerServer> | undefined;
  /**
   * At the end of a run: when `wakeId` holds the bot's slot, close the bot's browser (gracefully) and give the slot
   * back; otherwise do nothing (another run of the bot may be driving the computer).
   */
  release(botId: BotId, wakeId: string): Promise<void>;
}

/** A provider that refuses everything with `why` (no provider could be built); the tools refuse readably. */
function refusingProvider(why: string): ComputerProvider {
  const no = () => Promise.reject(new Error(why));
  return {
    capacity: no,
    ensure: no,
    exec: no,
    launch: no,
    screenshot: no,
    act: no,
    accessibilityTree: no,
    forwardPort: no,
    stop: no,
  };
}

/**
 * Build the computers of this process. The provider comes from settings.yaml through its plugin; a problem is
 * logged and leaves 0 slots with the problem as the slot text (startup never fails for it). Slots are computed once,
 * in the background, and logged as `computer.slots`.
 */
export function createComputers(d: ComputersDeps): Computers {
  const built = computerProvider(d.settings, d, d.plugins);
  const problem = built.problems.join("; ");
  // No computer block at all is no problem until a bot names a computer: then its tools say why.
  if (d.settings) for (const message of built.problems) d.log.warn({ message }, "computer.problem");
  const provider = built.provider ?? refusingProvider(problem);
  let slots = 0;
  let text = built.provider ? "computer slots not computed yet" : problem;
  const ready =
    built.provider && d.settings
      ? computerSlots(built.provider, d.settings).then((r) => {
          slots = r.slots;
          text = r.text;
          d.log.info({ slots: r.slots, limitedBy: r.limitedBy, text: r.text }, "computer.slots");
        })
      : Promise.resolve();
  const browsers = new Map<BotId, { key: string; browser: BrowserSession }>();
  const sleep = d.sleep ?? ((ms: number) => Bun.sleep(ms));

  const placement = (bot: Bot) => ({
    cdpPort: cdpPortOf(bot.id, bot.computer ?? "", d.bots()),
    profileDir: `${PROFILE_ROOT}/${bot.id}`,
  });

  /** The bot's browser, kept per process; a new placement (bots added or moved) gets a new one. */
  const browserOf = (bot: Bot, computer: string): BrowserSession => {
    const { cdpPort } = placement(bot);
    const key = `${computer}:${cdpPort}`;
    const known = browsers.get(bot.id);
    if (known?.key === key) return known.browser;
    void known?.browser.close().catch(() => undefined);
    const browser = new BrowserSession({
      provider,
      computer,
      botId: bot.id,
      cdpPort,
      profileRoot: PROFILE_ROOT,
    });
    browsers.set(bot.id, { key, browser });
    return browser;
  };

  return {
    slotLimit: () => slots,
    slotsText: () => text,
    ready,
    placement,
    server(spec) {
      const computer = spec.bot.computer;
      // The holder is the run's wake id (`runSpec` sets it for every stored run), so the run-end release finds it.
      const holder = spec.wakeId ?? spec.sessionKey;
      if (!computer || !holder) return undefined;
      return computerServer({
        botId: spec.bot.id,
        holder,
        computer: {
          name: computer,
          cpus: d.settings?.cpus ?? DEFAULT_CPUS,
          memoryMb: d.settings?.memoryMb ?? DEFAULT_MEMORY_MB,
        },
        provider,
        holds: d.holds,
        clock: d.clock,
        sleep,
        slotLimit: () => slots,
        slotsText: () => text,
        browser: browserOf(spec.bot, computer),
      });
    },
    async release(botId, wakeId) {
      const key = `slot:${botId}`;
      const held = (await d.holds.live(d.clock.now())).filter(
        (r) => r.key === key && r.holder === wakeId,
      );
      // This run never held the computer (or already gave it back): another run of the bot keeps both.
      if (held.length === 0) return;
      const lease = { holds: d.holds, clock: d.clock, sleep };
      try {
        await browsers.get(botId)?.browser.close();
      } finally {
        for (const row of held) await releaseSlot(lease, row);
      }
    },
  };
}
