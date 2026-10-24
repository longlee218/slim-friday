import { Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

/** Callout box: `info` (note, tip, important) uses the tint, `risk` (warning, caution) amber. */
export function Callout({ tone, children }: { tone: "info" | "risk"; children: ReactNode }) {
  const Icon = tone === "info" ? Info : TriangleAlert;
  return (
    <div className={tone === "info" ? "callout info" : "callout"}>
      <Icon aria-hidden strokeWidth={1.75} />
      <div>{children}</div>
    </div>
  );
}
