import type { ApprovalCardDto } from "@friday/contracts";

/** Summary and the key/value well (Tool, then each scope key) shared by the card and the sheet. */
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
    </>
  );
}
