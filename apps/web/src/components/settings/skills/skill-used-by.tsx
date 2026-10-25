import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { client } from "../../../api/client";
import { useDirectory } from "../../../api/directory";
import { Avatar } from "../../ui/avatar";
import { saveFailure } from "../field-error";
import { Switch } from "../form-parts";
import { refreshSkills } from "./install-skill-sheet";

/** The "Used by" switches: one per bot; a click sends the new full list of bots to `setUsedBy`. */
export function SkillUsedBy({ name, usedBy }: { name: string; usedBy: string[] }) {
  const dir = useDirectory();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string>();
  const toggle = async (id: string, on: boolean) => {
    setBusy(id);
    try {
      const botIds = on ? [...usedBy.filter((b) => b !== id), id] : usedBy.filter((b) => b !== id);
      await client.config.skills.setUsedBy({ name, botIds });
      await refreshSkills(qc);
    } catch (e) {
      toast.error(saveFailure(e).message);
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <>
      <h3 style={{ fontSize: 13, margin: "0 0 8px" }}>Used by</h3>
      <div className="list-panel">
        {[...dir.bots.values()].map((b) => (
          <div className="srow" key={b.id}>
            <Avatar src={b.avatarUrl} name={b.name} size={28} />
            <div className="grow">
              <b>{b.name}</b>
              <div className="t2">{b.title}</div>
            </div>
            <Switch
              label={`${b.name} uses ${name}`}
              on={usedBy.includes(b.id)}
              disabled={b.shipped === true || busy === b.id}
              onChange={(on) => void toggle(b.id, on)}
            />
          </div>
        ))}
      </div>
      <div className="foot-note">A bot loads the skill from its next session.</div>
    </>
  );
}
