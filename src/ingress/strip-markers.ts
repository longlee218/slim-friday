/** Remove every occurrence of `marks` from `text`, repeating until none is left ("<<<FI<<<FILELE" cannot rebuild one). */
export function stripMarkers(text: string, ...marks: string[]): string {
  let out = text;
  for (let prev = ""; prev !== out; ) {
    prev = out;
    for (const m of marks) out = out.replaceAll(m, "");
  }
  return out;
}
