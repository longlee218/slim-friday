import { useEffect, useState } from "react";

/** After this long the new-tab link is offered; the viewer sends no signal, so nothing is claimed. */
export const FRAME_HINT_MS = 10_000;

/** The viewer iframe; give it a `key` of its url so a new link restarts the hint timer. */
export function ComputerFrame({ url, controlling }: { url: string; controlling: boolean }) {
  const [hint, setHint] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setHint(true), FRAME_HINT_MS);
    return () => clearTimeout(timer);
  }, []);
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
      {hint && (
        <div className="r">
          Not showing?{" "}
          <a href={url} target="_blank" rel="noopener">
            Open the viewer in a new tab
          </a>
        </div>
      )}
    </div>
  );
}
