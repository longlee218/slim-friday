import { SettingsPage } from "../settings/settings-page";
import { ConversationSelect, FilesBody, type FilesViewProps, KindChips } from "./files-body";

/** `/files` on the phone: pushed from Settings; the type and chat filters over the list. */
export function PhoneFiles({
  kind,
  onKind,
  conversationId,
  onConversation,
  library,
  onOpen,
}: FilesViewProps) {
  return (
    <SettingsPage title="Files" inset>
      <div className="files-chips">
        <KindChips kind={kind} onKind={onKind} />
        <ConversationSelect conversationId={conversationId} onConversation={onConversation} />
      </div>
      <FilesBody library={library} onOpen={onOpen} />
    </SettingsPage>
  );
}
