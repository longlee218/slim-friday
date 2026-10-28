import {
  ComputerBusyError,
  controlState,
  giveBack,
  type LeaseDeps,
  OWNER_HOLDER,
  renewControl,
  takeControl,
} from "@friday/core";
import type { ApiDeps } from "../app";
import { COMPUTER_VIEW_PREFIX, revokeViewTokens } from "../computer/view-proxy";
import { MAX_LINK_MS, sealViewToken } from "../computer/view-token";
import { authed } from "../rpc/implementer";

/** The bot's computer name, or the error to throw: unknown bot and a bot without a computer are both NOT_FOUND. */
async function computerOf(deps: ApiDeps, botId: string): Promise<string | undefined | "missing"> {
  const bot = await deps.store.bots.get(botId);
  return bot ? bot.computer : "missing";
}

const leaseOf = (deps: ApiDeps): LeaseDeps => ({
  holds: deps.store.computerHolds,
  clock: { now: deps.now },
  sleep: (ms) => Bun.sleep(ms),
});

/** The owner's live input hold on `computer`, if any. */
async function ownerHold(deps: ApiDeps, computer: string) {
  const rows = await deps.store.computerHolds.live(deps.now());
  return rows.find((r) => r.key === `input:${computer}` && r.holder === OWNER_HOLDER);
}

/** The owner's window on a bot's computer: status, a sealed view link, and taking control. */
export const computerRouter = {
  status: authed.computer.status.handler(async ({ input, context, errors }) => {
    const { deps } = context;
    const computer = await computerOf(deps, input.botId);
    if (computer === "missing") throw errors.NOT_FOUND();
    const slots = deps.computers?.slots() ?? { limit: 0, text: "computers are not set up" };
    const used = (await deps.store.computerHolds.live(deps.now())).filter(
      (r) => r.kind === "slot",
    ).length;
    const running = computer
      ? await (deps.computers?.provider.running(computer) ?? Promise.resolve(false)).catch(
          () => false,
        )
      : false;
    return {
      ...(computer && { computer }),
      running,
      slots: { used, limit: slots.limit, text: slots.text },
      control: computer ? await controlState(leaseOf(deps), computer) : { holder: "none" as const },
    };
  }),
  view: authed.computer.view.handler(async ({ input, context, errors }) => {
    const { deps } = context;
    const computer = await computerOf(deps, input.botId);
    if (computer === "missing") throw errors.NOT_FOUND();
    if (!computer) throw errors.NOT_FOUND({ message: "This bot has no computer." });
    if (!deps.computers || !deps.viewSecret) {
      throw errors.CONFLICT({ message: "Computer view is not set up." });
    }
    if (
      input.mode === "control" &&
      (await controlState(leaseOf(deps), computer)).holder !== "owner"
    ) {
      throw errors.CONFLICT({ message: "Take control first." });
    }
    // The view never starts a stopped machine.
    const running = await deps.computers.provider.running(computer).catch(() => false);
    if (!running) {
      throw errors.CONFLICT({ message: `Computer "${computer}" is not running; nothing to view.` });
    }
    const view = await deps.computers.provider
      .view(deps.computers.spec(computer), { viewOnly: input.mode === "view" })
      .catch((err: unknown) => {
        throw errors.CONFLICT({ message: err instanceof Error ? err.message : String(err) });
      });
    const iat = deps.now();
    const exp = Math.min(view.expiresAt, iat + MAX_LINK_MS);
    if (exp <= iat) throw errors.CONFLICT({ message: "The viewer link has already expired." });
    const token = sealViewToken(deps.viewSecret, {
      computer,
      botId: input.botId,
      port: view.port,
      iat,
      exp,
      mode: input.mode,
    });
    // The viewer's own ticket rides in the fragment; the browser keeps it on our origin.
    const path = `${COMPUTER_VIEW_PREFIX}${token}/${new URL(view.url).hash}`;
    return { url: `${deps.publicApiUrl?.replace(/\/+$/, "") ?? ""}${path}`, expiresAt: exp };
  }),
  takeControl: authed.computer.takeControl.handler(async ({ input, context, errors }) => {
    const { deps } = context;
    const computer = await computerOf(deps, input.botId);
    if (!computer || computer === "missing") {
      throw errors.NOT_FOUND({ message: "This bot has no computer." });
    }
    try {
      return { expiresAt: (await takeControl(leaseOf(deps), computer)).expiresAt };
    } catch (err) {
      if (err instanceof ComputerBusyError) throw errors.CONFLICT({ message: err.message });
      throw err;
    }
  }),
  renewControl: authed.computer.renewControl.handler(async ({ input, context, errors }) => {
    const { deps } = context;
    const computer = await computerOf(deps, input.botId);
    if (!computer || computer === "missing") {
      throw errors.NOT_FOUND({ message: "This bot has no computer." });
    }
    const hold = await ownerHold(deps, computer);
    if (!hold || !(await renewControl(leaseOf(deps), hold))) return { ok: false };
    return { ok: true, expiresAt: (await ownerHold(deps, computer))?.expiresAt };
  }),
  giveBack: authed.computer.giveBack.handler(async ({ input, context, errors }) => {
    const { deps } = context;
    const computer = await computerOf(deps, input.botId);
    if (!computer || computer === "missing") {
      throw errors.NOT_FOUND({ message: "This bot has no computer." });
    }
    const hold = await ownerHold(deps, computer);
    if (hold) await giveBack(leaseOf(deps), hold);
    revokeViewTokens(computer, deps.now());
    return { ok: true as const };
  }),
};
