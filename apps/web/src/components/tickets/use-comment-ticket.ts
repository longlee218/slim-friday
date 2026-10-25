import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { client, orpc } from "../../api/client";

/** Posts an owner comment, then refetches that ticket (the count and timeline come with it). */
export function useCommentTicket(ref: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (text: string) => client.tickets.comment({ ref, text }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: orpc.tickets.get.key({ input: { ref } }) });
    },
    onError: () => toast("Could not post the comment. Try again."),
  });
}
