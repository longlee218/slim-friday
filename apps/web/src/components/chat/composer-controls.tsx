import { ArrowUp } from "lucide-react";
import { type Ref, type RefObject, useLayoutEffect } from "react";
import { composerMaxHeight } from "./composer-rules";

/** The round Send button: grey until the composer may send. */
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
