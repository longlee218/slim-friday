import { QueryClient } from "@tanstack/react-query";

/** Error codes a retry cannot fix. */
const NO_RETRY = new Set(["UNAUTHORIZED", "NOT_FOUND", "CONFLICT", "BAD_REQUEST"]);

/** Never retry a final answer; otherwise up to 2 retries. */
export function shouldRetry(count: number, error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code && NO_RETRY.has(code)) return false;
  return count < 2;
}

/** The app's single query cache. */
export const queryClient = new QueryClient({ defaultOptions: { queries: { retry: shouldRetry } } });

// Client-only entries (live runs, receipts, drafts) have no server copy to refetch: never
// garbage-collect them, even when written while no view observes them.
queryClient.setQueryDefaults(["web"], { gcTime: Number.POSITIVE_INFINITY });
