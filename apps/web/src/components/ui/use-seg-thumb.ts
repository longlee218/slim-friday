import { type CSSProperties, type RefObject, useLayoutEffect, useState } from "react";

/**
 * Position of a `.seg` thumb under button `at` of `box`: the button's measured box, kept in step
 * with resizes (narrow pane, phone font). Before the first measure, and where layout is not
 * available (tests), it falls back to `count` equal columns. `labels` re-measures when the text
 * of the buttons changes.
 */
export function useSegThumb(
  box: RefObject<HTMLElement | null>,
  at: number,
  count: number,
  labels: string,
): CSSProperties {
  const [measured, setMeasured] = useState<{ left: number; width: number } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `labels` changes the buttons' widths
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const b = at >= 0 ? el.querySelectorAll("button")[at] : undefined;
      const next = b?.offsetWidth ? { left: b.offsetLeft, width: b.offsetWidth } : null;
      setMeasured((m) => (m?.left === next?.left && m?.width === next?.width ? m : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [box, at, labels]);
  const width = `calc((100% - 4px) / ${count})`;
  return measured ?? { left: `calc(2px + ${at} * ${width})`, width };
}
