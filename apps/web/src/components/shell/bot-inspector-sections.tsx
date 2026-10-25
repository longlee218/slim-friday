import type { BotDto } from "@friday/contracts";
import { useQuery } from "@tanstack/react-query";
import { Brain, ListChecks } from "lucide-react";
import { orpc } from "../../api/client";
import { StatusDot } from "../tickets/ticket-status";
import { Button } from "../ui/button";
import { InspectorSection, Prop } from "./inspector-parts";
import { useAppNavigate } from "./use-app-navigate";

/** Memory block of the bot inspector: note and rule counts, the prompt meter, links to both pages. */
export function MemorySection({ bot }: { bot: BotDto }) {
  const go = useAppNavigate();
  const owner = `bot:${bot.id}` as const;
  const mem = useQuery(orpc.memory.list.queryOptions({ input: { owner } })).data;
  const rules = useQuery(orpc.memory.rules.get.queryOptions({ input: { owner } })).data;
  const used = mem && mem.capChars > 0 ? Math.min(100, (mem.promptChars / mem.capChars) * 100) : 0;
  return (
    <InspectorSection title="Memory">
      <Prop label="Notes">{mem ? mem.notes.length : "–"}</Prop>
      <Prop label="Rules">{rules ? `${rules.filter((r) => r.on).length} on` : "–"}</Prop>
      <div className="meter" style={{ margin: "8px 0 10px" }}>
        <i style={{ width: `${used}%` }} />
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <Button onClick={() => go(`/settings/bot/${bot.id}/memory`)}>
          <Brain strokeWidth={1.75} />
          Memory
        </Button>
        <Button onClick={() => go(`/settings/bot/${bot.id}/rules`)}>
          <ListChecks strokeWidth={1.75} />
          Rules
        </Button>
      </div>
    </InspectorSection>
  );
}

/** Tickets assigned to the bot that are not done or closed; a click opens it on the board. */
export function OpenTicketsSection({ botId }: { botId: string }) {
  const go = useAppNavigate();
  const items =
    useQuery(orpc.tickets.list.queryOptions({ input: { assignee: botId } })).data?.items ?? [];
  const open = items.filter((t) => t.status !== "done" && t.status !== "closed");
  return (
    <InspectorSection title="Open tickets">
      {open.length === 0 ? (
        <div style={{ color: "var(--label-2)" }}>None</div>
      ) : (
        open.map((t) => (
          <button
            key={t.id}
            type="button"
            className="member linkrow"
            onClick={() => go(`/tickets?t=${t.ref}`)}
          >
            <StatusDot status={t.status} />
            <div className="grow">
              <span className="tk">{t.ref}</span> {t.title}
            </div>
          </button>
        ))
      )}
    </InspectorSection>
  );
}
