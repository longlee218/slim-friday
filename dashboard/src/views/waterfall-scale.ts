/**
 * Time -> x (0..1) for the waterfall, with idle gaps folded. A goal often waits hours for the owner between
 * 20-second lead runs; on a linear axis those runs vanish. Gaps longer than GAP_MS take a fixed GAP_SHARE of the
 * width each and are drawn as breaks; busy time shares the rest in proportion.
 */
const GAP_MS = 10 * 60_000;
const GAP_SHARE = 0.03;
const TICK_STEP = 0.14;

interface Segment {
  from: number;
  to: number;
  gap: boolean;
  x0: number;
  x1: number;
}

export interface Scale {
  x: (t: number) => number;
  breaks: { x: number; x0: number; x1: number; ms: number }[];
  ticks: { x: number; t: number }[];
}

/** Build the scale from busy intervals (runs) and instants (events). */
export function buildScale(spans: [number, number][], points: number[]): Scale {
  const all = [...spans, ...points.map((p): [number, number] => [p, p])].sort((a, b) => a[0] - b[0]);
  if (!all.length) return { x: () => 0, breaks: [], ticks: [] };

  // Merge overlapping busy intervals, then mark the space between them busy or gap.
  const merged: [number, number][] = [];
  for (const [a, b] of all) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + GAP_MS) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  const raw: Omit<Segment, "x0" | "x1">[] = [];
  merged.forEach(([a, b], i) => {
    if (i > 0) raw.push({ from: merged[i - 1]![1], to: a, gap: true });
    raw.push({ from: a, to: Math.max(b, a + 1000), gap: false });
  });

  const gaps = raw.filter((s) => s.gap).length;
  const busyMs = raw.filter((s) => !s.gap).reduce((s, r) => s + (r.to - r.from), 0);
  const busyShare = 1 - gaps * GAP_SHARE;
  let cursor = 0;
  const segs: Segment[] = raw.map((s) => {
    const w = s.gap ? GAP_SHARE : ((s.to - s.from) / busyMs) * busyShare;
    const seg = { ...s, x0: cursor, x1: cursor + w };
    cursor += w;
    return seg;
  });

  const x = (t: number) => {
    const s = segs.find((g) => t <= g.to) ?? segs[segs.length - 1]!;
    if (t <= s.from) return s.x0;
    return s.x0 + ((Math.min(t, s.to) - s.from) / (s.to - s.from || 1)) * (s.x1 - s.x0);
  };
  const breaks = segs.filter((s) => s.gap).map((s) => ({ x: s.x0, x0: s.x0, x1: s.x1, ms: s.to - s.from }));
  // Ticks every ~TICK_STEP of width inside busy segments (folded gaps get none), never closer than TICK_STEP.
  const ticks: { x: number; t: number }[] = [];
  for (const s of segs.filter((g) => !g.gap)) {
    for (let xi = s.x0; xi < Math.min(s.x1, 0.94); xi += TICK_STEP) {
      if (ticks.length && xi - ticks[ticks.length - 1]!.x < TICK_STEP * 0.8) continue;
      ticks.push({ x: xi, t: s.from + ((xi - s.x0) / (s.x1 - s.x0)) * (s.to - s.from) });
    }
  }
  return { x, breaks, ticks };
}
