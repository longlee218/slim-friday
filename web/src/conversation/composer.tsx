import { AnimatePresence, motion } from "motion/react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { chatTitle, useChat } from "../chat/chat-store";
import type { Chat, Message } from "../chat/chat-types";
import { Icon } from "../ui/icon";
import { SWAP } from "../ui/motion-presets";
import { ComposerTray, DropOverlay } from "./composer-tray";
import { MentionPopover } from "./mention-popover";
import { useDraftAttachments } from "./use-draft-attachments";
import { useFileDrop } from "./use-file-drop";


interface Props {
  chat: Chat;
  autoFocus: boolean;
  /** Message being replied to, if any. */
  reply: Message | undefined;
  onCancelReply(): void;
}

/**
 * Message field with @mention (groups), reply bar, photo and file tray (attach or paste),
 * send, and Stop while a group runs.
 */
export function Composer({ chat, autoFocus, reply, onCancelReply }: Props) {
  const { runtime, teammate } = useChat();
  const drafts = useDraftAttachments();
  const dragging = useFileDrop(drafts.add);
  const picker = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [pick, setPick] = useState(0);
  const field = useRef<HTMLTextAreaElement>(null);
  const running = chat.kind === "group" && chat.run === "running";

  // @mention candidates for the word under the caret.
  const query = chat.kind === "group" ? text.slice(0, caret).match(/@(\w*)$/)?.[1] : undefined;
  const mentions =
    query === undefined || chat.kind !== "group"
      ? []
      : chat.members.map(teammate).filter((t) => t && t.name.toLowerCase().startsWith(query.toLowerCase()));

  const resize = () => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  const canSend = !running && (text.trim().length > 0 || drafts.files.length > 0);
  const send = () => {
    if (!canSend) return;
    runtime.send(chat.id, text.trim(), { replyTo: reply?.id, attachments: drafts.take() });
    setText("");
    onCancelReply();
    requestAnimationFrame(resize);
  };

  // Choosing Reply on a message moves the focus here.
  useEffect(() => {
    if (reply) field.current?.focus();
  }, [reply]);
  const insertMention = (name: string) => {
    const before = text.slice(0, caret).replace(/@(\w*)$/, `@${name} `);
    setText(before + text.slice(caret));
    setCaret(before.length);
    field.current?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentions.length > 0 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setPick((p) => (p + (e.key === "ArrowDown" ? 1 : mentions.length - 1)) % mentions.length);
      return;
    }
    if (mentions.length > 0 && (e.key === "Enter" || e.key === "Tab")) {
      e.preventDefault();
      const t = mentions[pick % mentions.length];
      if (t) insertMention(t.name);
      return;
    }
    if (e.key === "Escape" && reply) {
      e.preventDefault();
      onCancelReply();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="composer">
      <DropOverlay show={dragging} />
      <div className="composer__field">
        <MentionPopover mentions={mentions} pick={pick} onPick={insertMention} />
        <ComposerTray
          reply={reply}
          onCancelReply={onCancelReply}
          files={drafts.files}
          notice={drafts.notice}
          onRemove={drafts.remove}
        />
        <div className="composer__row">
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) drafts.add(e.target.files);
            e.target.value = "";
            field.current?.focus();
          }}
        />
        <button type="button" className="round" onClick={() => picker.current?.click()} aria-label="Attach photos or files" title="Attach photos or files">
          <Icon name="clip" />
        </button>
        <textarea
          ref={field}
          rows={1}
          value={text}
          autoFocus={autoFocus}
          placeholder={`Message ${chatTitle(chat, teammate)}`}
          aria-label="Message"
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart);
            setPick(0);
            resize();
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKey}
          onPaste={(e) => {
            // Pasted screenshots and files go to the tray; pasted text behaves as usual.
            if (e.clipboardData.files.length > 0) {
              e.preventDefault();
              drafts.add(e.clipboardData.files);
            }
          }}
        />
        {/* Send and Stop trade places with a quick scale and turn. */}
        <AnimatePresence mode="popLayout" initial={false}>
          {running ? (
            <motion.button
              key="stop"
              {...SWAP}
              type="button"
              className="round round--stop"
              onClick={() => runtime.stopGroup(chat.id)}
              aria-label="Stop the group"
              title="Stop"
            >
              <Icon name="stop" />
            </motion.button>
          ) : (
            <motion.button
              key="send"
              {...SWAP}
              type="button"
              className="round round--send"
              onClick={send}
              disabled={!canSend}
              aria-label="Send"
            >
              <Icon name="up" />
            </motion.button>
          )}
        </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
