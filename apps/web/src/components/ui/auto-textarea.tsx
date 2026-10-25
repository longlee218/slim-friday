import { type TextareaHTMLAttributes, useLayoutEffect, useRef } from "react";

/**
 * A textarea that grows with its text, so a long value is read whole without scrolling inside a
 * small box. `rows` stays the minimum height; the owner can still drag it taller.
 */
export function AutoTextarea(
  props: TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string },
) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure on every new value
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // `auto` resets to the `rows` height, then the content height (plus borders) wins when taller.
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [props.value]);
  return <textarea ref={ref} {...props} />;
}
