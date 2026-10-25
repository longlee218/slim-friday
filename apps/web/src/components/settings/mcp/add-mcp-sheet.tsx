import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { client, orpc } from "../../../api/client";
import { useIsPhone } from "../../../app/use-is-phone";
import { BottomSheet } from "../../ui/bottom-sheet";
import { Button } from "../../ui/button";
import { Sheet } from "../../ui/sheet";
import { Row } from "../form-parts";
import { type FieldErrors, useFormState } from "../use-form-state";
import { McpForm } from "./mcp-form";
import { type McpFormValue, NAME_HELP, NEW_MCP, toSpec, validateMcp, validName } from "./mcp-spec";
import { ConnBanner, McpStatusLine, useMcpProbe } from "./mcp-status";

type NewValue = McpFormValue & { name: string };

/** The contract's spec rules plus the server name. */
function validateNew(v: NewValue): FieldErrors<NewValue> {
  const errors: FieldErrors<NewValue> = validateMcp(v);
  if (!validName(v.name)) errors.name = NAME_HELP;
  return errors;
}

/** The sheet's fields; mounted only while the sheet is open, so a closed sheet forgets them. */
function AddMcpBody({ onClose, onAdded }: { onClose(): void; onAdded(name: string): void }) {
  const qc = useQueryClient();
  const form = useFormState<NewValue>({ ...NEW_MCP, name: "" }, validateNew);
  const probe = useMcpProbe();
  // The value the last test ran on: any edit makes it differ, which disables Add again.
  const { value } = form;
  const key = JSON.stringify(value);
  const [testedKey, setTestedKey] = useState("");
  const tested = probe.result?.state === "connected" && testedKey === key;

  const test = async () => {
    setTestedKey(key);
    await probe.run(value.name, value);
  };
  const add = () =>
    form.submit(async (v) => {
      await client.config.mcp.save({ name: v.name, server: toSpec(v), mode: "create" });
      await qc.invalidateQueries({ queryKey: orpc.config.mcp.key() });
      toast(`${v.name} added. Turn it on for a bot in its Tools & skills tab.`);
      onAdded(v.name);
      onClose();
    });

  return (
    <>
      <h3>Add MCP server</h3>
      <Row label="Name" htmlFor="mcp-name" error={form.errors.name}>
        <input
          id="mcp-name"
          className="field mono"
          placeholder="sentry"
          value={value.name}
          onChange={(e) => form.set("name", e.target.value)}
        />
      </Row>
      <McpForm value={value} errors={form.errors} onChange={form.set} />
      <Row label="Status">
        <McpStatusLine probe={probe} />
      </Row>
      {probe.result && probe.result.state !== "connected" && testedKey === key && (
        <ConnBanner probe={probe} onTest={() => void test()} />
      )}
      <div className="acts">
        <Button onClick={onClose}>Cancel</Button>
        <Button disabled={!form.valid || probe.running} onClick={() => void test()}>
          Test connection
        </Button>
        <Button variant="primary" disabled={!tested || form.saving} onClick={() => void add()}>
          Add server
        </Button>
      </div>
    </>
  );
}

/**
 * "Add MCP server": name, connection and a test. Add stays disabled until `config.mcp.test`
 * returned `connected` for the current field values.
 */
export function AddMcpSheet({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onAdded(name: string): void;
}) {
  const phone = useIsPhone();
  const Shell = phone ? BottomSheet : Sheet;
  return (
    <Shell open={open} onOpenChange={onOpenChange}>
      <AddMcpBody onClose={() => onOpenChange(false)} onAdded={onAdded} />
    </Shell>
  );
}
