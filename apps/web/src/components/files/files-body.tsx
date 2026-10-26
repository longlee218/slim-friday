import type { FileKind, FileLibraryItemDto } from "@friday/contracts";
import { useRef } from "react";
import { useDirectory } from "../../api/directory";
import { conversationName } from "../schedules/schedule-target";
import { Button } from "../ui/button";
import { useSegThumb } from "../ui/use-seg-thumb";
import { FileRow } from "./file-row";
import type { FileLibrary } from "./use-file-library";

export type KindFilter = FileKind | undefined;

const CHIPS: { kind: KindFilter; label: string }[] = [
  { kind: undefined, label: "All" },
  { kind: "image", label: "Images" },
  { kind: "pdf", label: "PDF" },
  { kind: "other", label: "Other" },
];

/** What a files screen needs: the filter, the library under it and how to open a row. */
export interface FilesViewProps {
  kind: KindFilter;
  onKind(kind: KindFilter): void;
  /** The chat the list is narrowed to; undefined shows every chat. */
  conversationId: string | undefined;
  onConversation(id: string | undefined): void;
  library: FileLibrary;
  onOpen(file: FileLibraryItemDto): void;
}

/** All / Images / PDF / Other (`.seg`); the thumb sits under the active button. */
export function KindChips({ kind, onKind }: Pick<FilesViewProps, "kind" | "onKind">) {
  const box = useRef<HTMLDivElement>(null);
  const at = CHIPS.findIndex((c) => c.kind === kind);
  const thumb = useSegThumb(box, at, CHIPS.length, "");
  return (
    <div ref={box} className="seg">
      <span className="thumb" style={thumb} />
      {CHIPS.map((c) => (
        <button
          type="button"
          key={c.label}
          className={c.kind === kind ? "on" : ""}
          aria-pressed={c.kind === kind}
          onClick={() => onKind(c.kind)}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

/** A select next to the chips: All chats, then each conversation by its bot or group name. */
export function ConversationSelect({
  conversationId,
  onConversation,
}: Pick<FilesViewProps, "conversationId" | "onConversation">) {
  const dir = useDirectory();
  return (
    <select
      className="field"
      style={{ width: "auto" }}
      aria-label="Chat"
      value={conversationId ?? ""}
      onChange={(e) => onConversation(e.target.value || undefined)}
    >
      <option value="">All chats</option>
      {dir.conversations.map((c) => (
        <option key={c.id} value={c.id}>
          {conversationName(c.id, dir) || c.title}
        </option>
      ))}
    </select>
  );
}

/** The rows, or the loading, error and empty state, and Load more under a partial list. */
export function FilesBody({ library, onOpen }: Pick<FilesViewProps, "library" | "onOpen">) {
  const dir = useDirectory();
  if (library.isLoading) return <div className="files-note">Loading…</div>;
  if (library.isError && library.items.length === 0)
    return (
      <div className="files-note">
        <p>Could not load your files.</p>
        <Button onClick={library.retry}>Try again</Button>
      </div>
    );
  if (library.items.length === 0)
    return <div className="files-note">No files yet. Files you send in chat appear here.</div>;
  return (
    <>
      <div className="panel files-list">
        {library.items.map((f) => (
          <FileRow
            key={f.id}
            file={f}
            chat={conversationName(f.conversationId, dir) || "Chat"}
            onOpen={onOpen}
          />
        ))}
      </div>
      {library.hasMore && (
        <div className="files-more">
          {library.loadMoreFailed && <p>Could not load more files.</p>}
          <Button disabled={library.loadingMore} onClick={library.loadMore}>
            Load more
          </Button>
        </div>
      )}
    </>
  );
}
