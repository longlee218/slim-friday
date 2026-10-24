/**
 * Stand-in for `@tanstack/react-virtual` in jsdom, which cannot measure layout (the real
 * virtualizer would render no rows). It renders every item; used via `vi.mock`.
 */
export function useVirtualizer({
  count,
  getItemKey,
}: {
  count: number;
  getItemKey: (i: number) => string | number;
}) {
  return {
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: getItemKey(index),
        start: index * 100,
        size: 100,
      })),
    getTotalSize: () => count * 100,
    measureElement: () => {},
  };
}
