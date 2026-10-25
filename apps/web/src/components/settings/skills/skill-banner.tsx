import type { SkillDto } from "@friday/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, Download, Package } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { client, orpc } from "../../../api/client";
import { Button } from "../../ui/button";
import { saveFailure } from "../field-error";
import { refreshSkills } from "./install-skill-sheet";
import { LookupResult, useLookup } from "./lookup-result";

/**
 * The banner of a skill: shipped, up to date (with "Check for updates") or update available.
 * "Update" looks the lock's source up and shows what it found; only "Update to <sha>" installs.
 */
export function SkillBanner({ skill }: { skill: SkillDto }) {
  const qc = useQueryClient();
  const lookup = useLookup();
  const [busy, setBusy] = useState(false);
  const [updateError, setUpdateError] = useState<string>();
  const key = orpc.config.skills.checkUpdate.queryKey({ input: { name: skill.name } });
  // The answer of the last check; this query never runs by itself.
  const check = useQuery({
    ...orpc.config.skills.checkUpdate.queryOptions({ input: { name: skill.name } }),
    enabled: false,
  }).data;

  if (skill.shipped) {
    return (
      <div className="conn ok">
        <Package />
        <div className="grow">
          <b>Shipped with Friday.</b> It updates with Friday and can't be removed; turn it off per
          bot below.
        </div>
      </div>
    );
  }

  const checkNow = async () => {
    try {
      const r = await qc.fetchQuery({
        queryKey: key,
        queryFn: () => client.config.skills.checkUpdate({ name: skill.name }),
        staleTime: 0,
      });
      if (!r.updateAvailable) toast(`${skill.name} is up to date.`);
    } catch (e) {
      toast.error(saveFailure(e).message);
    }
  };
  const update = async (name: string) => {
    if (!lookup.found) return;
    setBusy(true);
    setUpdateError(undefined);
    try {
      await client.config.skills.update({ lookupId: lookup.found.lookupId, name });
      qc.removeQueries({ queryKey: key });
      lookup.clear();
      await refreshSkills(qc);
      toast(`${name} updated. Bots use it from their next session.`);
    } catch (e) {
      setUpdateError(saveFailure(e).message);
    } finally {
      setBusy(false);
    }
  };
  const find = () => {
    setUpdateError(undefined);
    if (skill.source) void lookup.run(skill.source, skill.path);
  };

  const newSha = lookup.found?.sha.slice(0, 7) ?? check?.latestSha.slice(0, 7);
  return (
    <>
      {check?.updateAvailable ? (
        <div className="conn warn">
          <Download />
          <div className="grow">
            <b>Update available.</b> {skill.source} has moved to{" "}
            <span className="mono">{check.latestSha.slice(0, 7)}</span>.
          </div>
          <Button variant="primary" disabled={lookup.running} onClick={find}>
            Update
          </Button>
        </div>
      ) : (
        <div className="conn ok">
          <CircleCheck />
          <div className="grow">
            <b>Up to date.</b>
            {skill.installedAt &&
              ` Installed ${new Date(skill.installedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
            {skill.sha && (
              <>
                {" · "}
                <span className="mono">{skill.sha.slice(0, 7)}</span>
              </>
            )}
          </div>
          <Button onClick={() => void checkNow()}>Check for updates</Button>
        </div>
      )}
      {lookup.error && <div className="help err">{lookup.error}</div>}
      {lookup.found && (
        <LookupResult
          found={lookup.found}
          only={skill.name}
          confirmLabel={`Update to ${newSha}`}
          busy={busy}
          onConfirm={(n) => void update(n)}
        />
      )}
      {updateError && (
        <div className="help err">
          {updateError}{" "}
          <Button disabled={lookup.running} onClick={find}>
            Look up again
          </Button>
        </div>
      )}
    </>
  );
}
