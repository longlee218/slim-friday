import type { ApprovalCardDto } from "@friday/contracts";

/**
 * Summary, the key/value well (Tool, then each scope key) and the exact input the approval binds, shared by
 * the card and the sheet. "Allow once" lets exactly this call through, so the input is always shown; a cut input leaves only Deny.
 */
export function ApprovalDetail({ card }: { card: ApprovalCardDto }) {
  return (
    <>
      <p>{card.summary}</p>
      <dl className="kv">
        <dt>Tool</dt>
        <dd>{card.tool}</dd>
        {Object.entries(card.scope).map(([k, v]) => [
          <dt key={`${k}-k`}>{k}</dt>,
          <dd key={`${k}-v`}>{v}</dd>,
        ])}
      </dl>
      <pre className="appr-input">{card.input}</pre>
      {card.inputCut && (
        <p className="appr-cut">The call is too long to show in full, so it can only be denied.</p>
      )}
    </>
  );
}
