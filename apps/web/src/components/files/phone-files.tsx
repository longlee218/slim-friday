import { SettingsPage } from "../settings/settings-page";
import { FilesBody, type FilesViewProps, KindChips } from "./files-body";

/** `/files` on the phone: pushed from Settings; the type filter over the list. */
export function PhoneFiles({ kind, onKind, library, onOpen }: FilesViewProps) {
  return (
    <SettingsPage title="Files" inset>
      <div className="files-chips">
        <KindChips kind={kind} onKind={onKind} />
      </div>
      <FilesBody library={library} onOpen={onOpen} />
    </SettingsPage>
  );
}
