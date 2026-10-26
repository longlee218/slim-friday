import type { FileLibraryItemDto } from "@friday/contracts";
import { useState } from "react";
import { useIsPhone } from "../../app/use-is-phone";
import { ImageViewer } from "../chat/image-viewer";
import { useDownloadFile } from "../chat/use-download-file";
import type { KindFilter } from "./files-body";
import { FilesPage } from "./files-page";
import { PhoneFiles } from "./phone-files";
import { useFileLibrary } from "./use-file-library";

/**
 * `/files`: the owner's uploaded files. An image opens the viewer (arrows step through the
 * loaded images); any other file downloads (PDFs too, until the PDF viewer lands).
 */
export function FilesRoute() {
  const phone = useIsPhone();
  const [kind, setKind] = useState<KindFilter>(undefined);
  const [shown, setShown] = useState<string | null>(null);
  const library = useFileLibrary({ kind });
  const download = useDownloadFile();
  const images = library.items.filter((f) => f.kind === "image");
  const index = images.findIndex((f) => f.id === shown);
  const onOpen = (f: FileLibraryItemDto) => {
    if (f.kind === "image") setShown(f.id);
    else void download(f);
  };
  const view = { kind, onKind: setKind, library, onOpen };
  return (
    <>
      {phone ? <PhoneFiles {...view} /> : <FilesPage {...view} />}
      {index >= 0 && (
        <ImageViewer
          files={images}
          index={index}
          botName="You"
          at={images[index]?.at ?? 0}
          onClose={() => setShown(null)}
        />
      )}
    </>
  );
}
