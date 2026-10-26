import type { BotDto } from "@friday/contracts";
import { useQuery } from "@tanstack/react-query";
import { Brain, NotebookPen, SquareKanban } from "lucide-react";
import { orpc } from "../../api/client";
import { StatusDot } from "../tickets/ticket-status";
import { InspectorSection, PropLink } from "./inspector-parts";
import { useAppNavigate } from "./use-app-navigate";

/** Memory block of the bot inspector: note and rule counts, the prompt meter, links to both pages. */
export function MemorySection({ bot }: { bot: BotDto }) {
  const go = useAppNavigate();
  const owner = `bot:${bot.id}` as const;
  const mem = useQuery(orpc.memory.list.queryOptions({ input: { owner } })).data;
  const rules = useQuery(orpc.memory.rules.get.queryOptions({ input: { owner } })).data;
  const used = mem && mem.capChars > 0 ? Math.min(100, (mem.promptChars / mem.capChars) * 100) : 0;
  return (
    <InspectorSection title="Memory" icon={<Brain strokeWidth={1.75} />} tone="purple">
      <PropLink label="Notes" onClick={() => go(`/settings/bot/${bot.id}/memory`)}>
        {mem ? mem.notes.length : "–"}
      </PropLink>
      <PropLink label="Rules" onClick={() => go(`/settings/bot/${bot.id}/rules`)}>
        {rules ? `${rules.filter((r) => r.on).length} on` : "–"}
      </PropLink>
      {/* Share of the prompt budget memory uses; nothing to draw while it is empty. */}
      {used > 0 && (
        <div className="meter" style={{ margin: "8px 0 4px" }}>
          <i style={{ width: `${used}%` }} />
        </div>
      )}
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
    <InspectorSection title="Open tickets" icon={<SquareKanban strokeWidth={1.75} />} tone="green">
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

/**
 * The bot's open and parked scratchpad items, one block per scope (direct chat, then each group it is in).
 * Read only: the bot owns the list.
 */
export function ScratchpadSection({ botId }: { botId: string }) {
  const scopes =
    useQuery(orpc.config.bots.scratchpad.queryOptions({ input: { id: botId } })).data ?? [];
  return (
    <InspectorSection title="Scratchpad" icon={<NotebookPen strokeWidth={1.75} />} tone="orange">
      {scopes.length === 0 ? (
        <div style={{ color: "var(--label-2)" }}>Nothing open</div>
      ) : (
        scopes.map((s) => (
          <div key={typeof s.scope === "string" ? s.scope : s.scope.groupId}>
            <div className="t2">{typeof s.scope === "string" ? "Direct chat" : s.scope.name}</div>
            {s.items.map((i) => (
              <div key={i.id} className="member" title={i.notes || undefined}>
                <div className="grow">{i.title}</div>
                <span className="t2">{i.status}</span>
              </div>
            ))}
          </div>
        ))
      )}
    </InspectorSection>
  );
}
