import type { BotDto, ConversationDto, GroupDto } from "@friday/contracts";
import { AtSign, Camera, Paperclip, Plus } from "lucide-react";
import { type Ref, useImperativeHandle, useRef } from "react";
import { toast } from "sonner";
import { useDirectory } from "../../api/directory";
import { IconButton } from "../ui/button";
import { ComposerChips } from "./composer-chips";
import {
  CameraPicker,
  FilePicker,
  SendButton,
  useAutosize,
  useComposerHeight,
} from "./composer-controls";
import { placeholderFor, sendOnEnter } from "./composer-rules";
import { MentionPopover } from "./mention-popover";
import { ReplyBar } from "./reply-bar";
import { RouteChip } from "./route-chip";
import { useComposerSubmit } from "./use-composer-submit";
import { useMentionInput } from "./use-mention-input";
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
  /** Puts the caret in the textarea (after a suggestion fills the draft). */
  focus(): void;
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

/** Composer: a floating pill with autosize textarea, file chips, @mentions, route chip, reply bar and optimistic send. */
export function Composer(props: ComposerProps) {
  const { conversation, group, phone, reply, draft, onDraft } = props;
  const dir = useDirectory();
  const { uploads, add, remove, clear } = useUploads(conversation.id);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);

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
  useImperativeHandle(props.handleRef, () => ({ addFiles, focus: () => input.current?.focus() }));

  useAutosize(input, draft, phone);
  const wrap = useRef<HTMLDivElement>(null);
  useComposerHeight(wrap);

  const { route, ready, submit } = useComposerSubmit({
    ...props,
    names,
    uploads,
    clearUploads: clear,
  });

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
  const routeChip = group && route && <RouteChip route={route} />;
  const attach = () => fileInput.current?.click();

  // One floating glass pill on both widths: tools on the left, the growing text, the round Send.
  // The reply bar and the group's route chip ride above it; the transcript scrolls under all of it.
  return (
    <div ref={wrap} className={phone ? "chat-composer phone" : "chat-composer"}>
      {(replyBar || routeChip) && (
        <div className="comp-above">
          {replyBar}
          {routeChip}
        </div>
      )}
      <div className="composer">
        {popover}
        <FilePicker inputRef={fileInput} onFiles={addFiles} />
        {phone && <CameraPicker inputRef={cameraInput} onFiles={addFiles} />}
        <IconButton label={ATTACH} className="comp-ib" onClick={attach}>
          {phone ? <Plus strokeWidth={1.75} /> : <Paperclip strokeWidth={1.75} />}
        </IconButton>
        {phone && (
          <IconButton
            label="Take a photo"
            className="comp-ib"
            onClick={() => cameraInput.current?.click()}
          >
            <Camera strokeWidth={1.75} />
          </IconButton>
        )}
        {!phone && group && route && (
          <IconButton label="Mention a member" className="comp-ib" onClick={mention.startMention}>
            <AtSign strokeWidth={1.75} />
          </IconButton>
        )}
        <div className="comp-field">
          <ComposerChips uploads={uploads} onRemove={remove} />
          {textarea}
        </div>
        {send}
      </div>
    </div>
  );
}
