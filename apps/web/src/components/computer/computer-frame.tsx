import { useEffect, useState } from "react";

/** The viewer page posts this once it paints a frame (UNVERIFIED until the live check). */
export const FRAME_MESSAGE = "computer-frame";
/** Without a frame by then, the device is told it cannot play the stream. */
export const FRAME_TIMEOUT_MS = 10_000;

/** The viewer iframe; give it a `key` of its url so a new link restarts the frame timer. */
export function ComputerFrame({ url, controlling }: { url: string; controlling: boolean }) {
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    const origin = new URL(url, window.location.href).origin;
    const timer = setTimeout(() => setStalled(true), FRAME_TIMEOUT_MS);
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== origin || e.data?.type !== FRAME_MESSAGE) return;
      clearTimeout(timer);
      setStalled(false);
    };
    window.addEventListener("message", onMessage);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
    };
  }, [url]);
  return (
    <div>
      <iframe
        title="Computer"
        src={url}
        sandbox="allow-scripts allow-same-origin"
        style={{
          width: "100%",
          aspectRatio: "16 / 10",
          border: controlling ? "2px solid var(--tint)" : "1px solid var(--fill-strong)",
          borderRadius: 12,
          background: "var(--well)",
        }}
      />
      {stalled && <div className="r">This device cannot play the stream.</div>}
    </div>
  );
}
