import type { ComputerSettings } from "@friday/config";
import {
  type Bot,
  type BotId,
  type BotRuntimeSpec,
  type Clock,
  type ComputerProvider,
  type ComputerProviderPlugin,
  computerResume,
  type Log,
  releaseSlot,
  type Store,
  type WakeBot,
} from "@friday/core";
import { BrowserSession, computerServer } from "@friday/tools";
import { computerProvider } from "./computer-plugins";
import { cdpPortOf } from "./computer-ports";
import { slotCount } from "./computer-slot-count";

/** Where each bot's Chromium profile lives inside its computer (`<root>/<botId>`). */
export const PROFILE_ROOT = "/home/cua/friday-profiles";
/** Size of a computer when settings.yaml does not set it. */
const DEFAULT_CPUS = 2;
const DEFAULT_MEMORY_MB = 1536;

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
  /** Queue a system run for a bot (the hub's `queueSystemRun`, bound late: the hub is built after the computers). */
  wake?: WakeBot;
}

/** The computers of one process: the provider, the slots, a browser per bot and the run-end release. */
export interface Computers {
  /** Slots this machine allows at once (0 until computed, or when there is no provider). */
  slotLimit(): number;
  /** Readable slot line (or why there is none), for the `<computer>` facts and the tools' refusals. */
  slotsText(): string;
  /** Settles once the slots were computed at start (never rejects). */
  ready: Promise<void>;
  /** Awaited before a slot is taken: the first count, or a recount 30 s after a failed one. */
  slotsReady(): Promise<void>;
  /** Where a bot's browser lives in its computer. */
  placement(bot: Bot): { cdpPort: number; profileDir: string };
  /** The `computer` server of a session; undefined for a bot without a computer. */
  server(spec: BotRuntimeSpec): ReturnType<typeof computerServer> | undefined;
  /**
   * At the end of a run: when `wakeId` holds the bot's slot, close the bot's browser (gracefully) and give the slot
   * back; otherwise do nothing (another run of the bot may be driving the computer).
   */
  release(botId: BotId, wakeId: string): Promise<void>;
  /** The owner gave `computer` back or lost it: wake each bot its tools turned away meanwhile, once. */
  resumeAfterGiveBack(computer: string): Promise<void>;
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
 * logged and leaves 0 slots with the problem as the slot text (startup never fails for it). Slots are counted in the
 * background at start (see `slotCount`).
 */
export function createComputers(d: ComputersDeps): Computers {
  const built = computerProvider(d.settings, d, d.plugins);
  const problem = built.problems.join("; ");
  // No computer block at all is no problem until a bot names a computer: then its tools say why.
  if (d.settings) for (const message of built.problems) d.log.warn({ message }, "computer.problem");
  const provider = built.provider ?? refusingProvider(problem);
  const count = slotCount({
    ...(built.provider && { provider: built.provider }),
    ...(d.settings && { settings: d.settings }),
    problem,
    clock: d.clock,
    log: d.log,
  });
  /** Bots whose port shift was already logged (one warning per pair). */
  const shifted = new Set<string>();
  const browsers = new Map<BotId, { key: string; browser: BrowserSession }>();
  const sleep = d.sleep ?? ((ms: number) => Bun.sleep(ms));
  const resume = computerResume(async (botId, text, key) => d.wake?.(botId, text, key));

  const placement = (bot: Bot) => ({
    cdpPort: cdpPortOf(bot.id, bot.computer ?? "", d.bots(), (moved, holder) => {
      if (shifted.has(`${moved}:${holder}`)) return;
      shifted.add(`${moved}:${holder}`);
      d.log.warn({ botId: moved, sharesPortWith: holder }, "computer.port_shifted");
    }),
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
    slotLimit: count.slots,
    slotsText: count.text,
    ready: count.ready,
    slotsReady: count.refresh,
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
        slotLimit: count.slots,
        slotsText: count.text,
        slotsReady: count.refresh,
        browser: browserOf(spec.bot, computer),
        onOwnerBlocked: resume.noteBlockedByOwner,
      });
    },
    resumeAfterGiveBack: resume.resumeAfterGiveBack,
    async release(botId, wakeId) {
      const key = `slot:${botId}`;
      // `live(0)`: every row not released (expiresAt 0), lapsed TTL included: a lapsed slot still has a browser.
      const held = (await d.holds.live(0)).filter((r) => r.key === key && r.holder === wakeId);
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
