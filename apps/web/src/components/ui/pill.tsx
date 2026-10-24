import type { ReactNode } from "react";

/** Small status label; the tone picks the prototype colour. */
export function Pill({
  tone,
  children,
}: {
  tone: "amber" | "green" | "red" | "blue" | "violet" | "gray";
  children: ReactNode;
}) {
  return <span className={`pill ${tone}`}>{children}</span>;
}
