import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { client, orpc } from "../../api/client";
import { useControl } from "./use-control";

/** The status refreshes while the view is mounted so the holder stays current. */
export const STATUS_POLL_MS = 10_000;

type Mode = "view" | "control";

/**
 * A bot's computer as the owner sees it: status, the viewer link (nothing streams before `watch`),
 * and the control hold. Unmounting releases the hold and revokes the link. With `inlineErrors` a failed
 * link is kept in `error` for the caller to show instead of a toast.
 */
export function useComputerView(botId: string, { inlineErrors = false } = {}) {
  const statusQuery = useQuery(
    orpc.computer.status.queryOptions({ input: { botId }, refetchInterval: STATUS_POLL_MS }),
  );
  const control = useControl(botId);
  const [frame, setFrame] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Mints a link and (re)loads the frame with it. False on failure. */
  const load = useCallback(
    async (mode: Mode): Promise<boolean> => {
      try {
        setFrame((await client.computer.view({ botId, mode })).url);
        setError(null);
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Could not open the view";
        if (inlineErrors) setError(message);
        else toast.error(message);
        return false;
      }
    },
    [botId, inlineErrors],
  );

  // A lost hold falls back to a view-only frame.
  useEffect(() => {
    if (control.state === "lost") void load("view");
  }, [control.state, load]);

  const open = useRef({ frame, state: control.state });
  open.current = { frame, state: control.state };
  const gone = useRef(false);
  useEffect(() => {
    gone.current = false; // StrictMode re-runs the effect after its cleanup
    return () => {
      gone.current = true;
      if (open.current.state === "held") void client.computer.giveBack({ botId }).catch(() => {});
      if (open.current.frame) void client.computer.closeView({ botId }).catch(() => {});
    };
  }, [botId]);

  const takeControl = async () => {
    if (!(await control.take())) return;
    // The view closed while the bot finished its step: do not keep a hold nobody sees.
    if (gone.current) return void client.computer.giveBack({ botId }).catch(() => {});
    // No control link, no hold: release it so the bot is not left waiting.
    if (!(await load("control"))) await control.giveBack();
  };
  const giveBack = async () => {
    await control.giveBack();
    await load("view");
  };
  const close = async () => {
    if (control.state === "held") await control.giveBack();
    setFrame(null);
    setError(null);
    await client.computer.closeView({ botId }).catch(() => {});
  };

  return {
    statusQuery,
    status: statusQuery.data,
    control,
    controlling: control.state === "held",
    frame,
    error,
    watch: () => load("view"),
    takeControl,
    giveBack,
    close,
  };
}
