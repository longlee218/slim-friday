import { useIsPhone } from "../../app/use-is-phone";
import { Button } from "../ui/button";
import { ComputerFrame } from "./computer-frame";
import { useComputerView } from "./use-computer-view";

/** The owner's window on a bot's computer: status, a live view on demand, and taking control. */
export function ComputerPanel({ botId, botName }: { botId: string; botName: string }) {
  const phone = useIsPhone();
  const { statusQuery, status, control, controlling, frame, watch, takeControl, giveBack, close } =
    useComputerView(botId);

  if (!status) {
    return (
      <div className="r">
        {statusQuery.isError ? "Could not load the computer state." : "Loading…"}
      </div>
    );
  }
  if (!status.computer) return <div className="r">This bot has no computer.</div>;
  const dot = controlling
    ? "You have control · renews automatically"
    : status.control.holder === "bot"
      ? `Bot is using it (${botName})`
      : "Idle";

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
            <Button variant="primary" onClick={() => void watch()}>
              View
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
