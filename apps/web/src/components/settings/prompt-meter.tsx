import type { MemoryOwner } from "@friday/contracts";
import { useDirectory } from "../../api/directory";

/** Display name of a memory owner (`bot:<id>` or `group:<id>`); the id while the list loads. */
export function useOwnerName(owner: MemoryOwner): string {
  const dir = useDirectory();
  const [kind, id = ""] = owner.split(":");
  return (kind === "group" ? dir.groups.get(id)?.name : dir.bots.get(id)?.name) ?? id;
}

/**
 * The prototype's foot note under the notes: how much of the prompt the memory takes, and that the
 * bot saves notes too.
 */
export function PromptMeter({ name, used, cap }: { name: string; used: number; cap: number }) {
  return (
    <div className="foot-note">
      In {name}'s prompt: <span className="num">{(used / 1000).toFixed(1)}k</span> of{" "}
      {Math.round(cap / 1000)}k characters. {name} also saves notes itself; you can edit or delete
      any of them.
    </div>
  );
}
