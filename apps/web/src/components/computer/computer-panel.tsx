import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { client, orpc } from "../../api/client";
import { useIsPhone } from "../../app/use-is-phone";
import { Button } from "../ui/button";
import { ComputerFrame } from "./computer-frame";
import { useControl } from "./use-control";

/** The status refreshes while the panel is open so the holder stays current. */
const STATUS_POLL_MS = 10_000;

type Mode = "view" | "control";

/** The owner's window on a bot's computer: status, a live view on demand, and taking control. */
export function ComputerPanel({ botId, botName }: { botId: string; botName: string }) {
  const phone = useIsPhone();
  const statusQuery = useQuery(
    orpc.computer.status.queryOptions({ input: { botId }, refetchInterval: STATUS_POLL_MS }),
  );
  const status = statusQuery.data;
  const control = useControl(botId);
  const [frame, setFrame] = useState<string | null>(null);

  /** Mints a link and (re)loads the frame with it; nothing streams before the first call. False on failure. */
  const load = useCallback(
    async (mode: Mode): Promise<boolean> => {
      try {
        setFrame((await client.computer.view({ botId, mode })).url);
        return true;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not open the view");
        return false;
      }
    },
    [botId],
  );

  // A lost hold falls back to a view-only frame.
  useEffect(() => {
    if (control.state === "lost") void load("view");
  }, [control.state, load]);

  // Leaving the panel releases the hold and revokes the link.
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

  if (!status) {
    return (
      <div className="r">
        {statusQuery.isError ? "Could not load the computer state." : "Loading…"}
      </div>
    );
  }
  if (!status.computer) return <div className="r">This bot has no computer.</div>;
  const controlling = control.state === "held";
  const dot = controlling
    ? "You have control · renews automatically"
    : status.control.holder === "bot"
      ? `Bot is using it (${botName})`
      : "Idle";

  const takeControl = async () => {
    if (!(await control.take())) return;
    // The panel closed while the bot finished its step: do not keep a hold nobody sees.
    if (gone.current) return void client.computer.giveBack({ botId }).catch(() => {});
    // No control link, no hold: release it so the bot is not left waiting.
    if (!(await load("control"))) await control.giveBack();
  };
  const giveBack = async () => {
    await control.giveBack();
    await load("view");
  };
  const close = async () => {
    if (controlling) await control.giveBack();
    setFrame(null);
    await client.computer.closeView({ botId }).catch(() => {});
  };
  const actions = (
    <div
      style={{
        display: "flex",
        gap: 8,
        flexDirection: phone ? "column" : "row",
        marginTop: 12,
      }}
    >
      {controlling ? (
        <Button onClick={giveBack}>Give back</Button>
      ) : (
        <Button variant="primary" disabled={control.state === "waiting"} onClick={takeControl}>
          Take control
        </Button>
      )}
      <Button disabled={control.state === "waiting"} onClick={close}>
        Close
      </Button>
    </div>
  );

  return (
    <div className="computer-panel" style={{ padding: phone ? 0 : "0 4px" }}>
      <h3 style={{ margin: 0 }}>Computer "{status.computer}"</h3>
      <div className="r">{dot}</div>
      <div className="r">{status.slots.text}</div>
      {frame ? (
        <>
          <ComputerFrame key={frame} url={frame} controlling={controlling} />
          {control.state === "waiting" && (
            <div className="r">Waiting for the bot to finish its step…</div>
          )}
          {control.state === "lost" && <div className="r">Control lost: connection dropped.</div>}
          {controlling && (
            <div className="r">{botName} is waiting and resumes when you give back</div>
          )}
          {actions}
        </>
      ) : !status.running ? (
        <div className="r">Computer is off.</div>
      ) : (
        <>
          <div className="r">Nothing is streaming.</div>
          <div style={{ marginTop: 12 }}>
            <Button variant="primary" onClick={() => void load("view")}>
              View
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
