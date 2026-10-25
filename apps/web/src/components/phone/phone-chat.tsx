import type { MessageDto } from "@friday/contracts";
import { useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import { useParams } from "react-router";
import { orpc } from "../../api/client";
import { useDirectory } from "../../api/directory";
import { Composer, type ComposerHandle } from "../chat/composer";
import { conversationParts } from "../chat/conversation-parts";
import { EmptyConversation } from "../chat/empty-conversation";
import { Transcript } from "../chat/transcript";
import { useConversationEmpty } from "../chat/use-conversation-empty";
import { useDraft, useReplyTarget } from "../chat/use-drafts";
import { ChatTitleButton } from "./chat-title-button";
import { PhoneNavBar } from "./phone-nav-bar";
import { useBackLabel } from "./phone-shell";

/** Characters of the quoted message kept in the reply bar. */
const EXCERPT_CHARS = 140;

/**
 * Phone chat (`/c/:conversationId` below 640 px): the chat nav, the transcript (swipe to reply,
 * hold for actions) and the phone composer. Draft and reply target come from the same cache
 * entries as the desktop chat, so they survive a width crossing.
 */
export function PhoneChat() {
  const { conversationId = "" } = useParams();
  const dir = useDirectory();
  const listed = useQuery(orpc.conversations.list.queryOptions()).isSuccess;
  const conversation = dir.conversations.find((c) => c.id === conversationId);
  const empty = useConversationEmpty(conversationId, conversation !== undefined);
  const composer = useRef<ComposerHandle>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useDraft(conversationId);
  const [reply, setReply] = useReplyTarget(conversationId);
  const back = useBackLabel() ?? "Chats";

  if (!conversation) {
    return (
      <div className="ios-chat">
        <PhoneNavBar title="Conversation" back={back} scrollRef={scroll} />
        <div className="ios-scroll" ref={scroll}>
          {listed && (
            <div className="empty">
              <h3>This conversation doesn't exist.</h3>
            </div>
          )}
        </div>
      </div>
    );
  }

  const { bot, group } = conversationParts(dir, conversation);
  const onReply = (m: MessageDto) => {
    if (m.author.kind !== "bot") return;
    setReply({ messageId: m.id, botId: m.author.botId, excerpt: m.text.slice(0, EXCERPT_CHARS) });
    composer.current?.focus();
  };

  return (
    <div className="ios-chat">
      <ChatTitleButton conversation={conversation} bot={bot} group={group} />
      {empty ? (
        <div className="ios-scroll" ref={scroll}>
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
          phone
          onReply={onReply}
          onDropFiles={(files) => composer.current?.addFiles(files)}
        />
      )}
      <Composer
        key={`c:${conversation.id}`}
        conversation={conversation}
        group={group}
        phone
        reply={reply}
        onClearReply={() => setReply(null)}
        draft={draft}
        onDraft={setDraft}
        handleRef={composer}
      />
    </div>
  );
}
