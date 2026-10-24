import { TicketLink } from "../markdown/ticket-link";

/** Plain text where each `FRI-<n>` becomes an in-app ticket link (React text nodes, never HTML). */
export function TicketText({ text }: { text: string }) {
  // The capture group keeps the refs in the split result, at odd indexes.
  const parts = text.split(/(FRI-\d+)/g);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and static
          <TicketLink key={i} ticketRef={part} />
        ) : (
          part
        ),
      )}
    </>
  );
}
