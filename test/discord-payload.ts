/* Readers for a posted Discord message that is one components-v2 Container (question, approval, settled edit). */

/** JSON of the message's Container: `{ type: 17, accent_color, components: [...] }`. */
const box = (payload: any) => payload.components[0].toJSON();

/** Text of every TextDisplay in the Container, joined by a newline. */
export const textOf = (payload: any): string =>
  box(payload)
    .components.filter((c: any) => c.type === 10)
    .map((c: any) => c.content)
    .join("\n");

/** JSON of the action rows in the Container (the controls); empty once the message settled. */
export const rowsOf = (payload: any): any[] =>
  box(payload).components.filter((c: any) => c.type === 1);

/** Accent color (24-bit RGB) of the Container. */
export const accentOf = (payload: any): number => box(payload).accent_color;
