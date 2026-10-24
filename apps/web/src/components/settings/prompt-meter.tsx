import type { MemoryOwner } from "@friday/contracts";
import { useDirectory } from "../../api/directory";

/** Display name of a memory owner (`bot:<id>` or `group:<id>`); the id while the list loads. */
export function useOwnerName(owner: MemoryOwner): string {
  const dir = useDirectory();
  const [kind, id = ""] = owner.split(":");
  return (kind === "group" ? dir.groups.get(id)?.name : dir.bots.get(id)?.name) ?? id;
}

/** "In <name>'s prompt: 4.2k of 12k characters" with the prototype's `.meter` bar above it. */
export function PromptMeter({ name, used, cap }: { name: string; used: number; cap: number }) {
  return (
    <>
      <div className="meter" style={{ margin: "0 2px 8px" }}>
        <i style={{ width: `${Math.min(100, (used / cap) * 100)}%` }} />
      </div>
      <div className="foot-note" style={{ marginTop: 0 }}>
        In {name}'s prompt: <span className="num">{(used / 1000).toFixed(1)}k</span> of{" "}
        {Math.round(cap / 1000)}k characters.
      </div>
    </>
  );
}
