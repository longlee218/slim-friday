import type { BotId, Clock, ComputerProvider, ComputerSpec, Store } from "@friday/core";
import type { BrowserSession } from "./browser/browser-session";

/** What the computer tools of one session need. */
export interface ComputerContext {
  botId: BotId;
  /** Identifies this session in the holds store (a replaced holder loses its lease). */
  holder: string;
  computer: ComputerSpec;
  provider: ComputerProvider;
  holds: Store["computerHolds"];
  clock: Clock;
  sleep: (ms: number) => Promise<void>;
  /** Browser slots this machine allows at once (0 = none). */
  slotLimit: () => number;
  /** Readable summary of the slot situation, appended to the "no slot" refusal. */
  slotsText: () => string;
  browser: BrowserSession;
}
