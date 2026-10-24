import { useQuery } from "@tanstack/react-query";
import { type Receipt, receiptsKey } from "../../events/client-keys";

/**
 * The receipt of a card, read from the receipts cache the events and the answer mutations
 * write. Never fetches; an explicit `receipt` prop on a card wins over this.
 */
export function useReceipt(cardId: string): Receipt | undefined {
  const { data } = useQuery({
    queryKey: receiptsKey(),
    queryFn: () => ({}) as Record<string, Receipt>,
    enabled: false,
    select: (r) => r[cardId],
  });
  return data;
}
