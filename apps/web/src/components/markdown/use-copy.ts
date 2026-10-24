import { useCallback, useEffect, useRef, useState } from "react";

/** Copy `text` to the clipboard; `copied` stays true for 1500 ms. Timer cleared on unmount. */
export function useCopy(text: string): [copied: boolean, copy: () => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = useCallback(() => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1500);
      })
      // No clipboard permission: the label simply stays "Copy".
      .catch(() => {});
  }, [text]);
  return [copied, copy];
}
