import { ArrowUp } from "lucide-react";
import { type Ref, type RefObject, useEffect, useLayoutEffect } from "react";
import { composerMaxHeight } from "./composer-rules";

/** The round Send button: a quiet fill until the composer may send, then the gradient. */
export function SendButton({ disabled, onClick }: { disabled: boolean; onClick(): void }) {
  return (
    <button
      type="button"
      className="send"
      aria-label="Send"
      title="Send"
      disabled={disabled}
      onClick={onClick}
    >
      <ArrowUp strokeWidth={2.25} />
    </button>
  );
}

/** The hidden file input behind the attach button; it resets so the same file can be picked again. */
export function FilePicker({
  inputRef,
  onFiles,
}: {
  inputRef: Ref<HTMLInputElement>;
  onFiles(files: File[]): void;
}) {
  return (
    <input
      ref={inputRef}
      type="file"
      multiple
      hidden
      data-testid="file-input"
      onChange={(e) => {
        onFiles(Array.from(e.target.files ?? []));
        e.target.value = "";
      }}
    />
  );
}

/** Grows the textarea with its text up to the cap, then lets it scroll. */
export function useAutosize(
  ref: RefObject<HTMLTextAreaElement | null>,
  draft: string,
  phone: boolean,
) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure on every new draft
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, composerMaxHeight(phone))}px`;
  }, [ref, draft, phone]);
}

/** Distance from the bottom (px) within which the transcript stays pinned while the composer grows. */
const PINNED_PX = 80;

/**
 * The composer floats over the transcript: publish its height as `--composer-h` on the chat pane
 * (the transcript pads its bottom by it), and keep a transcript read at the bottom pinned there.
 */
export function useComposerHeight(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    const pane = el?.parentElement;
    if (!el || !pane || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const scroll = pane.querySelector<HTMLElement>(".chat-scroll");
      const pinned =
        !!scroll && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < PINNED_PX;
      pane.style.setProperty("--composer-h", `${el.offsetHeight}px`);
      if (scroll && pinned) scroll.scrollTop = scroll.scrollHeight;
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      pane.style.removeProperty("--composer-h");
    };
  }, [ref]);
}
