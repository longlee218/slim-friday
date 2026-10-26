import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { client, orpc } from "../../api/client";
import { Switch } from "./form-parts";

/**
 * The Auto Review switch (spec §6.14, `permissions.autoReview` in settings.yaml): when on, a quick model check may
 * clear a call the autonomy level would ask about; anything unclear still shows the card, with the check's reason
 * first. Off by default. The switch shows the saved value at once; a refused save puts it back with a toast.
 */
export function AutoReviewToggle() {
  const qc = useQueryClient();
  const key = orpc.config.permissions.get.queryKey();
  const on = useQuery(orpc.config.permissions.get.queryOptions()).data?.autoReview ?? false;
  const [saving, setSaving] = useState(false);

  /** Saves the new value; the engine applies it once its config watcher has reloaded the file. */
  async function change(next: boolean) {
    setSaving(true);
    qc.setQueryData(key, { autoReview: next });
    try {
      await client.config.permissions.setAutoReview({ autoReview: next });
      toast.success(`Auto Review ${next ? "on" : "off"}.`);
    } catch (e) {
      qc.setQueryData(key, { autoReview: !next });
      toast.error(e instanceof Error && e.message ? e.message : "That did not work. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="srow">
      <span className="ico tint">
        <Sparkles size={16} strokeWidth={1.75} />
      </span>
      <div className="grow">
        <b>Auto Review</b>
        <div className="t2">
          Before a card, a quick check compares the call with your own words that started the work.
          A clear fit runs without asking; anything else shows the card with the reason. It never
          denies.
        </div>
      </div>
      <Switch label="Auto Review" on={on} disabled={saving} onChange={(v) => void change(v)} />
    </div>
  );
}
