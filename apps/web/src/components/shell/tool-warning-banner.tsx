import { useQuery } from "@tanstack/react-query";
import { TriangleAlert, X } from "lucide-react";
import { useState } from "react";
import { orpc } from "../../api/client";

const DISMISSED_KEY = "friday.toolWarningDismissed";

function readDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissed() {
  try {
    sessionStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    // Storage blocked: the dismissal lasts until this component unmounts.
  }
}

/** Amber band next to the connection banner while a helper tool (uvx, pdftotext) is missing. */
export function ToolWarningBanner() {
  const [dismissed, setDismissed] = useState(readDismissed);
  const warnings =
    useQuery(orpc.control.toolCheck.queryOptions({ staleTime: Number.POSITIVE_INFINITY })).data ??
    [];
  if (dismissed || warnings.length === 0) return null;

  const text = warnings.map((w) => `${w.tool} is missing: ${w.hint}`).join(" · ");
  const dismiss = () => {
    writeDismissed();
    setDismissed(true);
  };
  return (
    <div className="banner" role="status">
      <TriangleAlert size={14} strokeWidth={1.75} aria-hidden="true" />
      <span className="banner-text" title={text}>
        {text}
      </span>
      <button type="button" className="banner-dismiss" aria-label="Dismiss" onClick={dismiss}>
        <X size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>
  );
}
