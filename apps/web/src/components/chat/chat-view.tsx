import type { MessageDto } from "@friday/contracts";
import { useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import { useParams } from "react-router";
import { orpc } from "../../api/client";
import { useDirectory } from "../../api/directory";
import type { ConnectionState } from "../../events/use-event-stream";
import { ConnectionBanner } from "../shell/connection-banner";
import { Toolbar } from "../shell/toolbar";
import { ChatToolbar } from "./chat-toolbar";
import { Composer, type ComposerHandle } from "./composer";
import { conversationParts } from "./conversation-parts";
import { EmptyConversation } from "./empty-conversation";
import { Transcript } from "./transcript";
import { useConversationEmpty } from "./use-conversation-empty";
import { useDraft, useReplyTarget } from "./use-drafts";

/** Characters of the quoted message kept in the reply bar. */
const EXCERPT_CHARS = 140;

/**
 * Desktop chat (route `/c/:conversationId`): toolbar, connection banner, transcript or the
 * empty state, and the composer. Drafts and reply targets live in the query cache
 * (`use-drafts.ts`) so they survive a width crossing; the composer itself is keyed by conversation so its files reset. Renders
 * inside `AppShell` (toolbar and panels need its context).
 */
export function ChatView({ connection = "live" }: { connection?: ConnectionState }) {
  const { conversationId = "" } = useParams();
  const dir = useDirectory();
  const listed = useQuery(orpc.conversations.list.queryOptions()).isSuccess;
  const status = useQuery(orpc.control.status.queryOptions()).data ?? [];
  const conversation = dir.conversations.find((c) => c.id === conversationId);
  const empty = useConversationEmpty(conversationId, conversation !== undefined);
  const composer = useRef<ComposerHandle>(null);
  // Draft and reply target live in the query cache, so they survive this view unmounting.
  const [draft, setDraft] = useDraft(conversationId);
  const [reply, setReply] = useReplyTarget(conversationId);

  if (!conversation) {
    return (
      <>
        <Toolbar title={<h1>Conversation</h1>} />
        <div className="content">
          {listed && (
            <div className="empty">
              <h3>This conversation doesn't exist.</h3>
            </div>
          )}
        </div>
      </>
    );
  }

  const { bot, group } = conversationParts(dir, conversation);

  const onReply = (m: MessageDto) => {
    if (m.author.kind !== "bot") return;
    setReply({
      messageId: m.id,
      botId: m.author.botId,
      excerpt: m.text.slice(0, EXCERPT_CHARS),
    });
    composer.current?.focus();
  };

  return (
    <>
      <ChatToolbar conversation={conversation} bot={bot} group={group} status={status} />
      <div className="chat-banner">
        <ConnectionBanner state={connection} />
      </div>
      {empty ? (
        <div className="content">
          <EmptyConversation
            conversation={conversation}
            bot={bot}
            group={group}
            onSuggest={(text) => {
              setDraft(text);
              composer.current?.focus();
            }}
          />
        </div>
      ) : (
        <Transcript
          key={`t:${conversation.id}`}
          conversation={conversation}
          phone={false}
          onReply={onReply}
          onDropFiles={(files) => composer.current?.addFiles(files)}
        />
      )}
      <Composer
        key={`c:${conversation.id}`}
        conversation={conversation}
        group={group}
        phone={false}
        reply={reply}
        onClearReply={() => setReply(null)}
        draft={draft}
        onDraft={setDraft}
        handleRef={composer}
      />
    </>
  );
}
