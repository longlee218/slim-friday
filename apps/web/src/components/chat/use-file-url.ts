import { useQuery } from "@tanstack/react-query";
import { orpc } from "../../api/client";

/** Presigned URLs live 15 minutes (CDN ones never expire), so 10 minutes is safe for both. */
const URL_STALE_MS = 10 * 60 * 1000;

/** The URL of a file plus whether the lookup failed; never built client-side. */
export function useFileUrlState(fileId: string): { url: string | undefined; failed: boolean } {
  const q = useQuery({
    ...orpc.chat.file.queryOptions({ input: { id: fileId } }),
    staleTime: URL_STALE_MS,
  });
  return { url: q.data?.url, failed: q.isError };
}

/** The URL of a file, or `undefined` while it loads. */
export function useFileUrl(fileId: string): string | undefined {
  return useFileUrlState(fileId).url;
}
