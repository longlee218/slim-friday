import { cuaPlugin } from "@friday/computer-cua";
import type { ComputerSettings } from "@friday/config";
import {
  type ComputerProvider,
  type ComputerProviderPlugin,
  computeSlots,
  type Log,
  type SlotResult,
} from "@friday/core";

/** The computer provider plugins this app ships: adding one = its package + one line here. */
export const COMPUTER_PLUGINS: ComputerProviderPlugin[] = [cuaPlugin as ComputerProviderPlugin];

/** Problem text when settings.yaml has no `computer` block but a bot names a computer. */
export const NO_COMPUTER_SETTINGS = "no computer provider is set (settings.yaml computer.provider)";

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The provider of the `computer.provider` entry of settings.yaml, through its plugin. An unknown id, bad options or
 * a failed check is a problem and there is no provider (the app runs, computer tools refuse). The plugin's options
 * get the owner's PATH and HOME as `env` unless the entry names its own (children never get the rest of the env).
 */
export function computerProvider(
  settings: ComputerSettings | undefined,
  deps: { log: Pick<Log, "warn" | "info">; env: Record<string, string | undefined> },
  plugins: ComputerProviderPlugin[] = COMPUTER_PLUGINS,
): { provider?: ComputerProvider; problems: string[] } {
  if (!settings) return { problems: [NO_COMPUTER_SETTINGS] };
  const { id, ...raw } = settings.provider;
  const plugin = plugins.find((p) => p.id === id);
  if (!plugin) return { problems: [`computer provider "${id}" has no plugin`] };
  const env = { PATH: deps.env.PATH ?? "", HOME: deps.env.HOME ?? "" };
  try {
    const options = plugin.parseOptions({ env, ...raw });
    const problems = plugin.check(options);
    if (problems.length) return { problems };
    return { provider: plugin.create(options, { log: deps.log }), problems: [] };
  } catch (err) {
    return { problems: [errText(err)] };
  }
}

/**
 * The machine's computer slots: the provider's capacity sized by the settings (`slots` may only lower the number).
 * A capacity failure (Docker not running) is 0 slots whose text says why, marked `failed` (it may be counted again).
 */
export async function computerSlots(
  provider: ComputerProvider,
  settings: ComputerSettings,
): Promise<SlotResult & { failed?: true }> {
  try {
    return computeSlots(await provider.capacity(), {
      ...(settings.slots !== undefined && { override: settings.slots }),
      ...(settings.perBotCpus !== undefined && { perBotCpus: settings.perBotCpus }),
      ...(settings.perBotMemoryMb !== undefined && { perBotMemoryMb: settings.perBotMemoryMb }),
    });
  } catch (err) {
    return {
      slots: 0,
      limitedBy: "setting",
      text: `0 slots, the computer capacity is unknown: ${errText(err)}`,
      failed: true,
    };
  }
}
