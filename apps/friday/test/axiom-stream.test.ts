import { describe, expect, test } from "bun:test";
import { AXIOM_FIELDS, axiomStream, pickAxiomFields } from "../src/observability/axiom-stream";

/** Client double with the one method the stream uses. */
const fakeClient = () => {
  const sent: { dataset: string; events: object[] }[] = [];
  return {
    sent,
    ingest: (dataset: string, events: object[]) => void sent.push({ dataset, events }),
    flush: async () => {},
  };
};

describe("axiom stream", () => {
  test("pickAxiomFields keeps only allow-listed keys", () => {
    const out = pickAxiomFields(JSON.stringify({ event: "wake.done", botId: "b1", secret: "x" }));
    expect(out).toEqual({ event: "wake.done", botId: "b1" });
  });

  test("a line with excerpt and text loses both", () => {
    const out = pickAxiomFields(
      JSON.stringify({ event: "wake.queued", excerpt: "hello", text: "hello", total_ms: 5 }),
    );
    expect(Object.keys(out).sort()).toEqual(["event", "total_ms"]);
    expect(AXIOM_FIELDS).not.toContain("excerpt");
    expect(AXIOM_FIELDS).not.toContain("text");
  });

  test("write ingests the picked fields into the dataset", () => {
    const c = fakeClient();
    axiomStream(c, "ds").write(JSON.stringify({ event: "wake.done", wakeId: "w1", text: "no" }));
    expect(c.sent).toEqual([{ dataset: "ds", events: [{ event: "wake.done", wakeId: "w1" }] }]);
  });

  test("a client that throws never throws out of write", () => {
    const c = {
      ingest: () => {
        throw new Error("boom");
      },
      flush: async () => {},
    };
    expect(() => axiomStream(c, "ds").write(JSON.stringify({ event: "x" }))).not.toThrow();
  });

  test("a line without an event is not sent", () => {
    const c = fakeClient();
    axiomStream(c, "ds").write(JSON.stringify({ msg: "hi", level: 30 }));
    expect(c.sent).toEqual([]);
  });
});
