import type { FileKind, FileLibraryItemDto } from "@friday/contracts";
import { useInfiniteQuery } from "@tanstack/react-query";
import { orpc } from "../../api/client";

export interface FileLibrary {
  items: FileLibraryItemDto[];
  isLoading: boolean;
  /** The first page (or a refresh) failed. */
  isError: boolean;
  /** The next page failed; the loaded rows stay and Load more retries it. */
  loadMoreFailed: boolean;
  hasMore: boolean;
  /** True while the next page is on its way. */
  loadingMore: boolean;
  loadMore(): void;
  retry(): void;
}

/** The owner's uploaded files, newest first, one page at a time (`nextCursor` starts the next). */
export function useFileLibrary(filter: { kind?: FileKind; conversationId?: string }): FileLibrary {
  const q = useInfiniteQuery(
    orpc.chat.files.infiniteOptions({
      input: (cursor: string | undefined) => ({ ...filter, cursor }),
      initialPageParam: undefined,
      getNextPageParam: (p: { nextCursor?: string }) => p.nextCursor,
    }),
  );
  return {
    items: q.data?.pages.flatMap((p) => p.items) ?? [],
    isLoading: q.isLoading,
    isError: q.isError && !q.isFetchNextPageError,
    loadMoreFailed: q.isFetchNextPageError,
    hasMore: q.hasNextPage,
    loadingMore: q.isFetchingNextPage,
    loadMore: () => void q.fetchNextPage(),
    retry: () => void q.refetch(),
  };
}
