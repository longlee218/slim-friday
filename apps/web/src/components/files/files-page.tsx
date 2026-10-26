import { Files } from "lucide-react";
import { Toolbar } from "../shell/toolbar";
import { ConversationSelect, FilesBody, type FilesViewProps, KindChips } from "./files-body";

/** `/files` on desktop: toolbar with the type and chat filters over the list of uploaded files. */
export function FilesPage({
  kind,
  onKind,
  conversationId,
  onConversation,
  library,
  onOpen,
}: FilesViewProps) {
  return (
    <section className="pane">
      <Toolbar
        title={
          <>
            <span className="sb-ico">
              <Files strokeWidth={1.75} />
            </span>
            <div>
              <h1>Files</h1>
              <div className="st">What you sent in chat</div>
            </div>
          </>
        }
        actions={
          <>
            <ConversationSelect conversationId={conversationId} onConversation={onConversation} />
            <KindChips kind={kind} onKind={onKind} />
          </>
        }
      />
      <div className="content">
        <div className="page files-page">
          <FilesBody library={library} onOpen={onOpen} />
        </div>
      </div>
    </section>
  );
}
