import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useLocation } from "react-router";
import { toast } from "sonner";
import { client, orpc } from "../../api/client";
import { type Directory, useDirectory } from "../../api/directory";
import { useIsPhone } from "../../app/use-is-phone";
import { saveFailure } from "../settings/field-error";
import { BottomSheet } from "../ui/bottom-sheet";
import { Button } from "../ui/button";
import { Sheet } from "../ui/sheet";
import { groupAfterBotRemoval } from "./bot-removal";
import { useAppNavigate } from "./use-app-navigate";

/** The bot or group a Delete was asked for. */
export interface DeleteTarget {
  kind: "bot" | "group";
  id: string;
}

/** One line per group the bot is in: what deleting the bot does to it. */
function groupOutcomes(dir: Directory, botId: string) {
  return [...dir.groups.values()]
    .filter((g) => g.members.includes(botId))
    .map((g) => {
      const next = groupAfterBotRemoval(g, botId);
      if (next.kind === "delete")
        return { id: g.id, gone: true, text: `${g.name} is deleted too.` };
      const entry =
        next.entryBot !== g.entryBot ? ` New entry bot: ${dir.botName(next.entryBot)}.` : "";
      return { id: g.id, gone: false, text: `Removed from ${g.name}.${entry}` };
    });
}

/**
 * The confirm of Delete from the chat list (a bottom sheet on the phone, a sheet on desktop). A
 * bot is deleted with `cascade`, so the sheet lists each group it leaves. Success toasts, and
 * leaves the chat when it is the open one. `target === null` is closed.
 */
export function DeleteChatSheet({
  target,
  onClose,
}: {
  target: DeleteTarget | null;
  onClose(): void;
}) {
  const dir = useDirectory();
  const qc = useQueryClient();
  const go = useAppNavigate();
  const { pathname } = useLocation();
  const [busy, setBusy] = useState(false);
  const Shell = useIsPhone() ? BottomSheet : Sheet;
  const isBot = target?.kind === "bot";
  const name = target
    ? isBot
      ? dir.botName(target.id)
      : (dir.groups.get(target.id)?.name ?? target.id)
    : "";
  const outcomes = target && isBot ? groupOutcomes(dir, target.id) : [];

  const remove = async () => {
    if (!target) return;
    setBusy(true);
    try {
      if (isBot) await client.config.bots.delete({ id: target.id, cascade: true });
      else await client.config.groups.delete({ id: target.id });
      await Promise.all([
        qc.invalidateQueries({ queryKey: orpc.config.bots.key() }),
        qc.invalidateQueries({ queryKey: orpc.config.groups.key() }),
        qc.invalidateQueries({ queryKey: orpc.conversations.key() }),
      ]);
      toast(`${name} deleted.`);
      onClose();
      if (pathname === `/c/${target.kind}:${target.id}`) go("/", { replace: true });
    } catch (e) {
      toast.error(saveFailure(e).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <h3>Delete {name}?</h3>
      <p style={{ color: "var(--label-2)", margin: "6px 0 10px" }}>
        {name} moves to the trash for 7 days, with its memory.{!isBot && " Its members stay."}
      </p>
      {outcomes.length > 0 && (
        <ul className="del-outcomes">
          {outcomes.map((o) => (
            <li key={o.id} className={o.gone ? "gone" : undefined}>
              {o.text}
            </li>
          ))}
        </ul>
      )}
      <div className="acts">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="danger" className="solid" disabled={busy} onClick={() => void remove()}>
          {isBot ? "Delete bot" : "Delete group"}
        </Button>
      </div>
    </Shell>
  );
}
