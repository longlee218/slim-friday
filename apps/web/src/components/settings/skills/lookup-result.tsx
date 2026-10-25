import type { SkillLookupDto } from "@friday/contracts";
import { Puzzle } from "lucide-react";
import { useCallback, useState } from "react";
import { client } from "../../../api/client";
import { Button } from "../../ui/button";
import { Pill } from "../../ui/pill";
import { saveFailure } from "../field-error";

/** State of one `config.skills.lookup`: the result, the error text and a running flag. */
export interface Lookup {
  found?: SkillLookupDto;
  error?: string;
  running: boolean;
  /** Clones the source on the host; nothing is installed. */
  run(source: string, path?: string): Promise<void>;
  clear(): void;
}

/** Runs `config.skills.lookup` and keeps the latest result or error. */
export function useLookup(): Lookup {
  const [found, setFound] = useState<SkillLookupDto>();
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState(false);
  const run = useCallback(async (source: string, path?: string) => {
    setRunning(true);
    setError(undefined);
    setFound(undefined);
    try {
      setFound(await client.config.skills.lookup(path ? { source, path } : { source }));
    } catch (e) {
      setError(saveFailure(e).message);
    } finally {
      setRunning(false);
    }
  }, []);
  const clear = useCallback(() => {
    setFound(undefined);
    setError(undefined);
  }, []);
  return { found, error, running, run, clear };
}

/**
 * What a lookup found: per skill its name, description, files and, in amber, the files that run
 * code. Each skill has one confirm button; nothing is installed before that click.
 */
export function LookupResult({
  found,
  only,
  confirmLabel,
  busy,
  onConfirm,
}: {
  found: SkillLookupDto;
  /** Show only the skill with this name (an update looks at one skill). */
  only?: string;
  confirmLabel: string;
  busy: boolean;
  onConfirm(name: string): void;
}) {
  const skills = found.skills.filter((s) => !only || s.name === only);
  if (skills.length === 0) return <div className="help err">No skill found at this source.</div>;
  return (
    <div className="list-panel" style={{ margin: "4px 0 0" }}>
      {skills.map((s) => (
        <div className="srow" key={s.name}>
          <span className="ico">
            <Puzzle size={16} strokeWidth={1.75} />
          </span>
          <div className="grow">
            <b className="mono">{s.name}</b>
            <div className="t2">{s.description}</div>
            <div className="t2">{s.files.join(", ")}</div>
            {s.scripts.length > 0 && (
              <div style={{ marginTop: 4 }}>
                <Pill tone="amber">runs code: {s.scripts.join(", ")}</Pill>
              </div>
            )}
          </div>
          <Button variant="primary" disabled={busy} onClick={() => onConfirm(s.name)}>
            {confirmLabel}
          </Button>
        </div>
      ))}
    </div>
  );
}
