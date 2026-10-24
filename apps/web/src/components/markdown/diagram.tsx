import { Copy, Maximize2, Workflow } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Button } from "../ui/button";
import { Sheet } from "../ui/sheet";
import { sanitizeSvg } from "./sanitize-svg";
import { useCopy } from "./use-copy";
import { useIsDark } from "./use-is-dark";

type State = { status: "loading" } | { status: "done"; svg: string } | { status: "failed" };

/** Light / dark mermaid colours (from the prototype `renderDiagrams`). */
function themeVariables(dark: boolean) {
  const primary = dark ? "#2c3358" : "#e8edff";
  const border = dark ? "#6d8bff" : "#3a5cf2";
  return {
    darkMode: dark,
    background: "transparent",
    primaryColor: primary,
    primaryBorderColor: border,
    primaryTextColor: dark ? "#f2f2f5" : "#1c1c1f",
    lineColor: dark ? "#8e8e96" : "#8a8a92",
    secondaryColor: dark ? "#3a3a3e" : "#f2f2f6",
    tertiaryColor: dark ? "#2a2a2d" : "#ffffff",
    noteBkgColor: dark ? "#4a3a12" : "#fff4dc",
    noteTextColor: dark ? "#ffd27a" : "#7a4500",
    actorBkg: primary,
    actorBorder: border,
    fontSize: "13px",
  };
}

/** One shared lazy import, so every diagram on screen reuses the same mermaid instance. */
let mermaidModule: Promise<typeof import("mermaid")> | undefined;
const loadMermaid = () => {
  mermaidModule ??= import("mermaid");
  return mermaidModule;
};

/** Body of a diagram: drawing, drawn (SVG) or failed (message + source). */
function DiagramBody({ state, source }: { state: State; source: string }) {
  if (state.status === "loading") return <div className="dg loading">Drawing…</div>;
  if (state.status === "failed") {
    return (
      <div className="dg failed">
        <p>Could not draw this diagram.</p>
        <pre>{source}</pre>
      </div>
    );
  }
  // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid SVG rendered with securityLevel "strict"
  return <div className="dg" dangerouslySetInnerHTML={{ __html: state.svg }} />;
}

/**
 * Mermaid diagram with "Source" (copies) and "Expand" (wide sheet). Mermaid is loaded lazily,
 * runs with `securityLevel: "strict"`, and redraws when the theme changes.
 */
export function Diagram({ source }: { source: string }) {
  const dark = useIsDark();
  // `useId` gives ":r1:"-style ids; mermaid needs a plain element id.
  const id = `mmd${useId().replace(/[^A-Za-z0-9]/g, "")}`;
  const [state, setState] = useState<State>({ status: "loading" });
  const [open, setOpen] = useState(false);
  const [copied, copy] = useCopy(source);

  useEffect(() => {
    let live = true;
    loadMermaid()
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          suppressErrorRendering: true,
          theme: "base",
          fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font"),
          themeVariables: themeVariables(dark),
        });
        const { svg } = await mermaid.render(id, source);
        if (live) setState({ status: "done", svg: sanitizeSvg(svg) });
      })
      .catch(() => live && setState({ status: "failed" }));
    return () => {
      live = false;
    };
  }, [source, dark, id]);

  return (
    <div className="diagram">
      <div className="cb-h">
        <span>
          <Workflow aria-hidden strokeWidth={1.75} /> Diagram
        </span>
        <span>
          <button type="button" className="ib" onClick={copy}>
            <Copy aria-hidden strokeWidth={1.75} />
            {copied ? "Copied" : "Source"}
          </button>
          <button type="button" className="ib" onClick={() => setOpen(true)}>
            <Maximize2 aria-hidden strokeWidth={1.75} />
            Expand
          </button>
        </span>
      </div>
      {/* Only one SVG at a time: the sheet shows it while open, so ids stay unique. */}
      {open ? null : <DiagramBody state={state} source={source} />}
      <Sheet wide open={open} onOpenChange={setOpen}>
        <h3>Diagram</h3>
        <div className="diagram">
          <DiagramBody state={state} source={source} />
        </div>
        <div className="acts">
          <Button variant="primary" onClick={() => setOpen(false)}>
            Done
          </Button>
        </div>
      </Sheet>
    </div>
  );
}
