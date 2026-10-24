import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { client, orpc } from "../../../api/client";
import { useIsPhone } from "../../../app/use-is-phone";
import { BottomSheet } from "../../ui/bottom-sheet";
import { Button } from "../../ui/button";
import { Sheet } from "../../ui/sheet";
import { saveFailure } from "../field-error";
import { Row } from "../form-parts";
import { LookupResult, useLookup } from "./lookup-result";

/** Refreshes the skill lists and the bots (their skills may change). */
export const refreshSkills = (qc: ReturnType<typeof useQueryClient>) =>
  Promise.all([
    qc.invalidateQueries({ queryKey: orpc.config.skills.key() }),
    qc.invalidateQueries({ queryKey: orpc.config.bots.key() }),
  ]);

/** The sheet's fields; mounted only while the sheet is open, so a closed sheet forgets them. */
function InstallBody({
  onClose,
  onInstalled,
}: {
  onClose(): void;
  onInstalled(name: string): void;
}) {
  const qc = useQueryClient();
  const lookup = useLookup();
  const [source, setSource] = useState("");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [installError, setInstallError] = useState<string>();
  const find = () => {
    setInstallError(undefined);
    void lookup.run(source.trim(), path.trim() || undefined);
  };
  const install = async (name: string) => {
    if (!lookup.found) return;
    setBusy(true);
    setInstallError(undefined);
    try {
      await client.config.skills.install({ lookupId: lookup.found.lookupId, name });
      await refreshSkills(qc);
      toast(`${name} installed. Give it to a bot in Tools & skills.`);
      onInstalled(name);
      onClose();
    } catch (e) {
      // An expired or used lookup says "not confirmed": the owner looks the source up again.
      setInstallError(saveFailure(e).message);
    } finally {
      setBusy(false);
    }
  };
  const edit = (set: (v: string) => void) => (e: { target: { value: string } }) => {
    set(e.target.value);
    lookup.clear();
    setInstallError(undefined);
  };

  return (
    <>
      <h3>Install skill</h3>
      <Row
        label="From"
        htmlFor="skill-src"
        error={lookup.error}
        help="An https git URL. Friday checks it before it is installed."
      >
        <input
          id="skill-src"
          className="field mono"
          placeholder="https://github.com/owner/repo"
          value={source}
          onChange={edit(setSource)}
        />
      </Row>
      <Row label="Folder" htmlFor="skill-path" help="Optional: the folder inside the repo.">
        <input
          id="skill-path"
          className="field mono"
          placeholder="skills/name"
          value={path}
          onChange={edit(setPath)}
        />
      </Row>
      {lookup.found && (
        <LookupResult found={lookup.found} confirmLabel="Install" busy={busy} onConfirm={install} />
      )}
      {installError && (
        <div className="help err">
          {installError}{" "}
          <Button disabled={lookup.running} onClick={find}>
            Look up again
          </Button>
        </div>
      )}
      <div className="acts">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!source.trim() || lookup.running} onClick={find}>
          {lookup.running ? "Looking up…" : "Look up"}
        </Button>
      </div>
    </>
  );
}

/** "Install skill": source and folder, a lookup, then one Install button per skill found. */
export function InstallSkillSheet({
  open,
  onOpenChange,
  onInstalled,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onInstalled(name: string): void;
}) {
  const Shell = useIsPhone() ? BottomSheet : Sheet;
  return (
    <Shell open={open} onOpenChange={onOpenChange}>
      <InstallBody onClose={() => onOpenChange(false)} onInstalled={onInstalled} />
    </Shell>
  );
}
