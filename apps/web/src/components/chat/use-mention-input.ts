import type { BotDto } from "@friday/contracts";
import { type KeyboardEvent, type RefObject, useLayoutEffect, useRef, useState } from "react";
import { matchMembers } from "./mention-popover";
import { insertMention, mentionQuery } from "./mentions";

/**
 * @mention state of the composer textarea: the caret, the highlighted row, and whether the
 * popover was dismissed (Esc, blur, a pick) since the last edit. `members` is empty outside a group.
 */
export function useMentionInput(opts: {
  draft: string;
  onDraft(text: string): void;
  members: BotDto[];
  input: RefObject<HTMLTextAreaElement | null>;
}) {
  const { draft, onDraft, members, input } = opts;
  const [caret, setCaret] = useState(0);
  const [sel, setSel] = useState(0);
  const [closed, setClosed] = useState(false);

  // Caret to restore once the new text is in the textarea (a controlled value moves it to the end).
  const nextCaret = useRef<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs after each new draft
  useLayoutEffect(() => {
    if (nextCaret.current === null) return;
    input.current?.setSelectionRange(nextCaret.current, nextCaret.current);
    nextCaret.current = null;
  }, [draft, input]);

  const query = members.length && !closed ? mentionQuery(draft, caret) : null;
  const shown = query === null ? [] : matchMembers(members, query);
  const open = shown.length > 0;
  const selected = Math.min(sel, Math.max(shown.length - 1, 0));

  /** Replaces the `@query` by the member's name and puts the caret after it. */
  const pick = (b: BotDto) => {
    const at = insertMention(draft, input.current?.selectionStart ?? caret, b.name);
    onDraft(at.text);
    setCaret(at.caret);
    setClosed(true);
    nextCaret.current = at.caret;
  };

  /** Handles ↑/↓/Enter/Tab/Esc while the popover is open; true when the key was consumed. */
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open) return false;
    const n = shown.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      setSel((selected + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
      e.preventDefault();
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      pick(shown[selected] as BotDto);
      e.preventDefault();
      return true;
    }
    if (e.key === "Escape") {
      setClosed(true);
      e.stopPropagation();
      return true;
    }
    return false;
  };

  return {
    query,
    open,
    selected,
    pick,
    onKey,
    /** Types `@` at the end (the "Mention a member" button). */
    startMention() {
      const text = `${draft}${draft && !/\s$/.test(draft) ? " " : ""}@`;
      onDraft(text);
      setCaret(text.length);
      setClosed(false);
      input.current?.focus();
    },
    /** Call on every edit or caret move. */
    track(el: HTMLTextAreaElement, edited: boolean) {
      setCaret(el.selectionStart);
      if (edited) setClosed(false);
    },
    dismiss: () => setClosed(true),
    reopen: () => setClosed(false),
  };
}
