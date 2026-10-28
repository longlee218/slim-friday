import { ExternalLink, Maximize2, Minimize2, Monitor, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { usePanels } from "../shell/use-responsive-panels";
import { Button, IconButton } from "../ui/button";
import { useComputerView } from "./use-computer-view";

/** The viewer renders at this desktop size; the compact card scales it down like a thumbnail. */
const VIEW_W = 1280;
const VIEW_H = 800;

/** Width of `el`, kept current. */
function useWidthOf(el: HTMLElement | null): number {
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return w;
}

/**
 * The bot's computer in the chat inspector: a live thumbnail of the screen, and a click away a
 * stage that widens the inspector for watching closely and taking control. The iframe keeps its
 * place in the tree across both, so switching never reloads the stream.
 */
export function ComputerCard({ botId, botName }: { botId: string; botName: string }) {
  const panels = usePanels();
  const { setInspectorWide } = panels;
  const wide = panels.inspectorWide;
  const v = useComputerView(botId);
  const [screen, setScreen] = useState<HTMLDivElement | null>(null);
  const width = useWidthOf(screen);

  // Leaving the chat collapses the stage.
  useEffect(() => () => setInspectorWide(false), [setInspectorWide]);
  useEffect(() => {
    if (!wide) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setInspectorWide(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [wide, setInspectorWide]);

  const { status, control, controlling, frame } = v;
  const waiting = control.state === "waiting";
  const running = status?.running ?? false;
  const botBusy = status?.control.holder === "bot";

  const chip = controlling
    ? { tone: "you", text: "You're in control" }
    : botBusy
      ? { tone: "bot", text: `${botName} is using it` }
      : frame
        ? { tone: "live", text: "Live" }
        : running
          ? { tone: "idle", text: "Idle" }
          : { tone: "off", text: "Off" };

  const expand = () => setInspectorWide(true);

  const scale = width > 0 ? width / VIEW_W : 0;
  const iframeStyle = wide
    ? { width: "100%", height: "100%" }
    : {
        width: VIEW_W,
        height: VIEW_H,
        transform: `scale(${scale})`,
        pointerEvents: "none" as const,
      };

  return (
    <section className={wide ? "insp-sec pc wide" : "insp-sec pc"} aria-label="Computer">
      <header className="pc-head">
        <span className="insp-tile purple">
          <Monitor strokeWidth={1.75} />
        </span>
        <h3>
          Computer
          {wide && status?.computer && <span className="pc-name">{status.computer}</span>}
        </h3>
        {wide && frame && (
          <a
            className="ib"
            href={frame}
            target="_blank"
            rel="noopener"
            aria-label="Open in a new tab"
            title="Open in a new tab"
          >
            <ExternalLink size={16} strokeWidth={1.75} />
          </a>
        )}
        <IconButton
          label={wide ? "Collapse (Esc)" : "Expand"}
          onClick={() => setInspectorWide(!wide)}
        >
          {wide ? (
            <Minimize2 size={16} strokeWidth={1.75} />
          ) : (
            <Maximize2 size={16} strokeWidth={1.75} />
          )}
        </IconButton>
      </header>

      <div
        ref={setScreen}
        className={controlling ? "pc-screen held" : "pc-screen"}
        data-live={frame ? "" : undefined}
      >
        {frame ? (
          <>
            <iframe
              key={frame}
              title={`${botName}'s computer`}
              src={frame}
              sandbox="allow-scripts allow-same-origin"
              style={iframeStyle}
            />
            {!wide && (
              <button type="button" className="pc-hit" aria-label="Expand" onClick={expand} />
            )}
          </>
        ) : (
          <div className="pc-empty">
            {!status ? null : !running ? (
              <>
                <Monitor size={22} strokeWidth={1.5} />
                <span>Computer is off</span>
              </>
            ) : (
              <button type="button" className="pc-play" onClick={() => void v.watch()}>
                <Play size={14} strokeWidth={2} fill="currentColor" />
                Watch live
              </button>
            )}
          </div>
        )}
        <span className={`pc-chip ${chip.tone}`}>
          <i />
          {chip.text}
        </span>
      </div>

      {wide && (
        <footer className="pc-foot">
          <div className="pc-note">
            {waiting
              ? `Waiting for ${botName} to finish its step…`
              : control.state === "lost"
                ? "Control lost: the connection dropped."
                : controlling
                  ? `${botName} pauses and resumes when you give back.`
                  : status?.slots.text}
          </div>
          {frame && (
            <div className="pc-actions">
              <Button disabled={waiting} onClick={() => void v.close()}>
                Stop watching
              </Button>
              {controlling ? (
                <Button variant="primary" onClick={() => void v.giveBack()}>
                  Give back
                </Button>
              ) : (
                <Button variant="primary" disabled={waiting} onClick={() => void v.takeControl()}>
                  Take control
                </Button>
              )}
            </div>
          )}
        </footer>
      )}
    </section>
  );
}
