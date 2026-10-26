import { Files } from "lucide-react";
import { Toolbar } from "../shell/toolbar";
import { FilesBody, type FilesViewProps, KindChips } from "./files-body";

/** `/files` on desktop: toolbar with the type filter over the list of uploaded files. */
export function FilesPage({ kind, onKind, library, onOpen }: FilesViewProps) {
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
        actions={<KindChips kind={kind} onKind={onKind} />}
      />
      <div className="content">
        <div className="page files-page">
          <FilesBody library={library} onOpen={onOpen} />
        </div>
      </div>
    </section>
  );
}
