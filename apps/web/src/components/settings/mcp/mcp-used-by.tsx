import { BotInputDtoSchema } from "@friday/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { client, orpc } from "../../../api/client";
import { useDirectory } from "../../../api/directory";
import { Avatar } from "../../ui/avatar";
import { saveFailure } from "../field-error";
import { Switch } from "../form-parts";

/**
 * The "Used by" switches: one per bot. A switch edits only that bot's `tools` (adds or removes
 * `mcp__<name>`). It builds the save from a bot fetched at click time, never from a cached
 * list, so a newer bot config is not overwritten.
 */
export function McpUsedBy({ name, usedBy }: { name: string; usedBy: string[] }) {
  const dir = useDirectory();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string>();
  const ref = `mcp__${name}`;

  const toggle = async (id: string, on: boolean) => {
    setBusy(id);
    try {
      const fresh = await qc.fetchQuery({
        queryKey: orpc.config.bots.get.queryKey({ input: { id } }),
        queryFn: () => client.config.bots.get({ id }),
        staleTime: 0,
      });
      // `mcp__<name>__<tool>` entries go with the server when it is turned off.
      const rest = fresh.tools.filter((t) => t !== ref && !t.startsWith(`${ref}__`));
      const tools = on ? [...fresh.tools.filter((t) => t !== ref), ref] : rest;
      await client.config.bots.save({
        id,
        bot: { ...BotInputDtoSchema.parse(fresh), tools },
        mode: "update",
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: orpc.config.mcp.key() }),
        qc.invalidateQueries({ queryKey: orpc.config.bots.key() }),
      ]);
      toast.success("Saved.");
    } catch (e) {
      toast.error(saveFailure(e).message);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <>
      <h3 className="grp-h">Used by</h3>
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
    </>
  );
}
