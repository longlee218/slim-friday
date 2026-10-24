import type { BotDto, ConversationDto, GroupDto } from "@friday/contracts";
import { AtSign, Paperclip, Plus } from "lucide-react";
import { type Ref, useImperativeHandle, useRef } from "react";
import { toast } from "sonner";
import { useDirectory } from "../../api/directory";
import { IconButton } from "../ui/button";
import { ComposerChips } from "./composer-chips";
import { FilePicker, SendButton, useAutosize } from "./composer-controls";
import { canSend, placeholderFor, sendOnEnter } from "./composer-rules";
import { MentionPopover } from "./mention-popover";
import { routeOf } from "./mentions";
import { ReplyBar } from "./reply-bar";
import { RouteChip } from "./route-chip";
import type { RouteInfo } from "./route-info";
import { useMentionInput } from "./use-mention-input";
import { useSendMessage } from "./use-send-message";
import { useUploads } from "./use-uploads";

/** The bot message the owner is replying to. */
export interface ReplyTarget {
  messageId: number;
  botId: string;
  excerpt: string;
}

/** What a parent (the transcript drop zone) can call. */
export interface ComposerHandle {
  addFiles(files: File[]): void;
}

export interface ComposerProps {
  conversation: ConversationDto;
  group?: GroupDto;
  phone: boolean;
  reply: ReplyTarget | null;
  onClearReply(): void;
  /** The draft text lives in the chat view so it survives a width crossing. */
  draft: string;
  onDraft(text: string): void;
  handleRef?: Ref<ComposerHandle>;
}

const ATTACH = "Attach files (up to 5, 20 MB each)";

/** Composer: autosize textarea, file chips, @mentions, route chip, reply bar and optimistic send. */
export function Composer(props: ComposerProps) {
  const { conversation, group, phone, reply, draft, onDraft } = props;
  const dir = useDirectory();
  const sender = useSendMessage();
  const { uploads, add, remove, clear } = useUploads(conversation.id);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const names = new Map([...dir.bots].map(([id, b]) => [id, b.name]));
  const members = (group?.members ?? [])
    .map((id) => dir.bots.get(id))
    .filter((b): b is BotDto => !!b);
  const mention = useMentionInput({ draft, onDraft, members, input });

  /** Starts uploads for dropped, pasted or picked files; a refusal is a toast. */
  const addFiles = (files: File[]) => {
    const error = files.length ? add(files) : null;
    if (error) toast(error);
  };
  useImperativeHandle(props.handleRef, () => ({ addFiles }));

  useAutosize(input, draft, phone);

  const route: RouteInfo | null = group
    ? routeOf({ text: draft, replyToBotId: reply?.botId, group, names })
    : conversation.botId
      ? { botIds: [conversation.botId], reason: "direct" }
      : null;
  const ready = canSend({ text: draft, uploads });

  /** Optimistic send, then a clean composer (draft, files, reply). */
  const submit = () => {
    if (!ready || !route) return;
    const uploadIds = uploads.flatMap((u) => (u.uploadId ? [u.uploadId] : []));
    void sender.send({
      payload: {
        conversationId: conversation.id,
        text: draft.trimEnd(),
        ...(uploadIds.length && { uploadIds }),
        ...(reply && { replyTo: reply.messageId }),
      },
      route,
      ...(reply && { quote: { botId: reply.botId, excerpt: reply.excerpt } }),
    });
    onDraft("");
    clear();
    props.onClearReply();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // IME composition (Vietnamese): Enter and arrows belong to the IME, never to us.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (mention.onKey(e)) return;
    const k = { key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing };
    if (sendOnEnter(k, phone)) {
      e.preventDefault();
      submit();
    }
  };

  const placeholder = placeholderFor(conversation.title, group?.name, phone);

  const textarea = (
    <textarea
      ref={input}
      rows={1}
      aria-label="Message"
      placeholder={placeholder}
      value={draft}
      onChange={(e) => {
        onDraft(e.target.value);
        mention.track(e.target, true);
      }}
      onSelect={(e) => mention.track(e.currentTarget, false)}
      onKeyDown={onKeyDown}
      onFocus={mention.reopen}
      onBlur={() => setTimeout(mention.dismiss, 120)}
      onPaste={(e) => {
        const files = Array.from(e.clipboardData.files);
        if (files.length) {
          e.preventDefault();
          addFiles(files);
        }
      }}
    />
  );
  const popover = mention.open && group && (
    <MentionPopover
      members={members}
      groupName={group.name}
      entryId={group.entryBot}
      query={mention.query ?? ""}
      selected={mention.selected}
      onPick={mention.pick}
    />
  );
  const replyBar = reply && (
    <ReplyBar
      botName={names.get(reply.botId) ?? reply.botId}
      excerpt={reply.excerpt}
      onCancel={props.onClearReply}
    />
  );
  const send = <SendButton disabled={!ready} onClick={submit} />;
  const chips = <ComposerChips uploads={uploads} onRemove={remove} />;
  const attach = () => fileInput.current?.click();

  if (phone) {
    return (
      <div className="ios-composer">
        {popover}
        {replyBar}
        {group && route && (
          <div className="route-row">
            <RouteChip route={route} />
          </div>
        )}
        {chips}
        <FilePicker inputRef={fileInput} onFiles={addFiles} />
        <IconButton label={ATTACH} className="plus" onClick={attach}>
          <Plus strokeWidth={1.75} />
        </IconButton>
        <div className="box">
          {textarea}
          {send}
        </div>
      </div>
    );
  }
  return (
    <div className="composer-wrap">
      <div className="composer">
        {popover}
        {replyBar}
        {chips}
        {textarea}
        <FilePicker inputRef={fileInput} onFiles={addFiles} />
        <div className="comp-bar">
          <IconButton label={ATTACH} onClick={attach}>
            <Paperclip size={17} strokeWidth={1.75} />
          </IconButton>
          {group && route && (
            <>
              <IconButton label="Mention a member" onClick={mention.startMention}>
                <AtSign size={17} strokeWidth={1.75} />
              </IconButton>
              <RouteChip route={route} />
            </>
          )}
          <span className="hint">↩ send · ⇧↩ new line</span>
          {send}
        </div>
      </div>
    </div>
  );
}
