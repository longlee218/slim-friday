import type { ConversationDto, GroupDto } from "@friday/contracts";
import type { ReplyTarget } from "./composer";
import { canSend } from "./composer-rules";
import { composerRoute } from "./mentions";
import { useSendMessage } from "./use-send-message";
import type { UploadChip } from "./use-uploads";

/** What the composer hands in: its conversation, draft, reply target and file chips. */
export interface ComposerSubmitInput {
  conversation: ConversationDto;
  group?: GroupDto;
  names: Map<string, string>;
  draft: string;
  onDraft(text: string): void;
  reply: ReplyTarget | null;
  onClearReply(): void;
  uploads: UploadChip[];
  clearUploads(): void;
}

/**
 * The composer's route, whether it may send, and `submit`: the optimistic send, then a clean
 * composer (draft, files, reply).
 */
export function useComposerSubmit(s: ComposerSubmitInput) {
  const sender = useSendMessage();
  const { conversation, draft, reply, uploads } = s;
  const route = composerRoute({
    text: draft,
    replyToBotId: reply?.botId,
    group: s.group,
    botId: conversation.botId,
    names: s.names,
  });
  const ready = canSend({ text: draft, uploads });

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
    s.onDraft("");
    s.clearUploads();
    s.onClearReply();
  };
  return { route, ready, submit };
}
