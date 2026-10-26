import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { client, orpc } from "../../../api/client";
import { useIsPhone } from "../../../app/use-is-phone";
import { BottomSheet } from "../../ui/bottom-sheet";
import { Button } from "../../ui/button";
import { Sheet } from "../../ui/sheet";
import { SheetForm } from "../../ui/sheet-bar";
import { saveFailure } from "../field-error";
import { Group, Row } from "../form-parts";
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

  const canFind = source.trim() !== "" && !lookup.running;
  return (
    <SheetForm
      title="Install skill"
      onCancel={onClose}
      onSubmit={() => {
        if (canFind) find();
      }}
      action={
        <button type="submit" className="nb strong" disabled={!canFind}>
          {lookup.running ? "Looking up…" : "Look up"}
        </button>
      }
    >
      <Group foot="An https git URL, and optionally the folder inside the repo. Friday checks it before it is installed.">
        <Row label="From" htmlFor="skill-src" error={lookup.error}>
          <input
            id="skill-src"
            className="field mono"
            placeholder="https://github.com/owner/repo"
            value={source}
            onChange={edit(setSource)}
          />
        </Row>
        <Row label="Folder" htmlFor="skill-path">
          <input
            id="skill-path"
            className="field mono"
            placeholder="skills/name (optional)"
            value={path}
            onChange={edit(setPath)}
          />
        </Row>
      </Group>
      {lookup.found && (
        <LookupResult found={lookup.found} confirmLabel="Install" busy={busy} onConfirm={install} />
      )}
      {installError && (
        <div className="grp-f err">
          {installError}{" "}
          <Button disabled={lookup.running} onClick={find}>
            Look up again
          </Button>
        </div>
      )}
    </SheetForm>
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
