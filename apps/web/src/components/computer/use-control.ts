import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { client } from "../../api/client";

/** How often the page renews the owner's hold; the server hold lasts 30 s. */
export const CONTROL_RENEW_MS = 10_000;

/** `waiting`: the bot is finishing its step; `lost`: a renew failed and the hold is gone. */
export type ControlState = "idle" | "waiting" | "held" | "lost";

/** The owner's hold on a bot's computer: take, renew every 10 s while held, give back (also on pagehide). */
export function useControl(botId: string) {
  const [state, setState] = useState<ControlState>("idle");
  const held = state === "held";

  /** True once the hold is taken; takeControl waits for the bot's running step server side. */
  const take = useCallback(async (): Promise<boolean> => {
    setState("waiting");
    try {
      await client.computer.takeControl({ botId });
      setState("held");
      return true;
    } catch (err) {
      setState("idle");
      toast.error(err instanceof Error ? err.message : "Could not take control");
      return false;
    }
  }, [botId]);

  const giveBack = useCallback(async () => {
    setState("idle");
    try {
      await client.computer.giveBack({ botId });
    } catch {
      toast.error("Could not give control back");
    }
  }, [botId]);

  useEffect(() => {
    if (!held) return;
    const lost = () => setState("lost");
    const timer = setInterval(() => {
      client.computer
        .renewControl({ botId })
        .then((r) => {
          if (!r.ok) lost();
        })
        .catch(lost);
    }, CONTROL_RENEW_MS);
    const onHide = () => void client.computer.giveBack({ botId }).catch(() => {});
    window.addEventListener("pagehide", onHide);
    return () => {
      clearInterval(timer);
      window.removeEventListener("pagehide", onHide);
    };
  }, [held, botId]);

  return { state, take, giveBack };
}
