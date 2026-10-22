import type { Teammate } from "../chat/chat-types";
import { ROLE_LABEL } from "../chat/role-labels";
import { ROLE_TEMPLATES } from "../chat/role-templates";
import { timeLabel } from "../chat/time-label";
import { Avatar } from "../ui/avatar";
import { MarkdownView, PageHeader } from "./inspector-parts";

/**
 * What a teammate works from: its role template, the owner's own instructions,
 * and the memory it keeps. Read-only; memory is written by the teammate itself.
 */
export function AgentPage({ t, onBack }: { t: Teammate; onBack(): void }) {
  const tpl = ROLE_TEMPLATES[t.role];
  return (
    <div className="page">
      <PageHeader title={t.name} onBack={onBack} />
      <div className="page__who">
        <Avatar name={t.avatar} size={40} />
        <span>
          <b>{ROLE_LABEL[t.role]} template</b>
          <span>{t.model}</span>
        </span>
      </div>

      <section className="page__section">
        <h3>Instructions</h3>
        <p className="page__lead">{tpl.summary}</p>
        <dl className="facts">
          <dt>Tools</dt>
          <dd>{tpl.tools.join(", ")}</dd>
          <dt>Needs you</dt>
          <dd>{tpl.approvals}</dd>
        </dl>
        {t.instructions ? (
          <blockquote className="own">
            <b>Your instructions</b>
            {t.instructions}
          </blockquote>
        ) : (
          <p className="page__empty">No instructions of your own.</p>
        )}
      </section>

      <section className="page__section">
        <h3>
          Memory
          {t.memoryUpdatedAt && <small>Updated {timeLabel(t.memoryUpdatedAt)}</small>}
        </h3>
        {t.memory ? (
          <MarkdownView text={t.memory} />
        ) : (
          <p className="page__empty">Nothing saved yet. {t.name} writes notes here as work goes on.</p>
        )}
      </section>
    </div>
  );
}
