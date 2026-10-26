import type { FileKind, FileLibraryItemDto } from "@friday/contracts";
import { useInfiniteQuery } from "@tanstack/react-query";
import { orpc } from "../../api/client";

export interface FileLibrary {
  items: FileLibraryItemDto[];
  isLoading: boolean;
  isError: boolean;
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
    isError: q.isError,
    hasMore: q.hasNextPage,
    loadingMore: q.isFetchingNextPage,
    loadMore: () => void q.fetchNextPage(),
    retry: () => void q.refetch(),
  };
}
