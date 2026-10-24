/** Count bubble; `bump` replays the 30% scale-1.25 keyframe when the count changes. */
export function Badge({
  tone,
  count,
  bump,
}: {
  tone: "amber" | "tint" | "red";
  count: number;
  bump?: boolean;
}) {
  return <span className={`badge ${tone}${bump ? " bump" : ""}`}>{count}</span>;
}
