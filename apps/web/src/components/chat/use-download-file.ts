import type { FileDto } from "@friday/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { orpc } from "../../api/client";

/**
 * Returns a function that downloads a file. The URL is fetched on click (non-image URLs carry
 * `dl=`), so nothing costs anything until used.
 */
export function useDownloadFile(): (file: FileDto) => Promise<void> {
  const qc = useQueryClient();
  return async (file) => {
    try {
      const { url } = await qc.fetchQuery({
        ...orpc.chat.file.queryOptions({ input: { id: file.id } }),
        staleTime: 10 * 60 * 1000,
      });
      const a = document.createElement("a");
      a.href = url;
      a.download = file.name;
      a.rel = "noopener";
      a.click();
    } catch {
      toast("Could not download this file. Try again.");
    }
  };
}
