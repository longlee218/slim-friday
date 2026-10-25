import { useQuery } from "@tanstack/react-query";

/** Reads a client-only cache entry the event stream writes (never fetches). */
export function useLocal<T>(key: readonly unknown[], empty: T): T {
  return useQuery({ queryKey: key, queryFn: () => empty, enabled: false }).data ?? empty;
}
