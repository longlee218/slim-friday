import { MAX_OWNER_FILE_CHARS } from "@friday/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { client, orpc } from "../../api/client";
import { useIsPhone } from "../../app/use-is-phone";
import { BotMarkdown } from "../markdown/bot-markdown";
import { Button } from "../ui/button";
import { SaveBar, Segmented } from "./form-parts";
import { SettingsPage } from "./settings-page";
import { useFormState } from "./use-form-state";

/** What each route file is: the contract's file key, its title and the hint under it. */
const FILES = {
  user: { key: "USER", file: "USER.md", title: "About you" },
  soul: { key: "SOUL", file: "SOUL.md", title: "Personality" },
} as const;

const MODES = ["Edit", "Preview"] as const;

/** The editor of one loaded owner file. */
function EditorForm({ file, text }: { file: keyof typeof FILES; text: string }) {
  const { key, file: name, title } = FILES[file];
  const qc = useQueryClient();
  const phone = useIsPhone();
  const [mode, setMode] = useState<(typeof MODES)[number]>("Edit");
  const form = useFormState({ text });
  const chars = form.value.text.length;
  const tooLong = chars > MAX_OWNER_FILE_CHARS;
  const save = () =>
    form.submit(async (v) => {
      await client.config.owner.save({ file: key, text: v.text });
      qc.setQueryData(orpc.config.owner.get.queryKey({ input: { file: key } }), {
        file: key,
        text: v.text,
      });
      toast("The bot uses it from its next turn");
    });
  const canSave = form.dirty && !tooLong && !form.saving;

  return (
    <SettingsPage
      title={title}
      right={
        phone && (
          <Button variant="primary" disabled={!canSave} onClick={save}>
            Save
          </Button>
        )
      }
    >
      <div className="page-head">
        <div className="grow">
          <h2>
            {title}{" "}
            <span
              className="mono"
              style={{ fontSize: 13, color: "var(--label-2)", fontWeight: 500 }}
            >
              {name}
            </span>
          </h2>
          <div className="r">Every bot reads it before each turn.</div>
        </div>
        <Segmented label="Mode" options={MODES} value={mode} onChange={setMode} />
      </div>
      {mode === "Preview" ? (
        <div className="list-panel of-preview">
          <BotMarkdown text={form.value.text} />
        </div>
      ) : (
        <textarea
          className="field of-edit"
          aria-label={`${name} text`}
          spellCheck={false}
          value={form.value.text}
          onChange={(e) => form.set("text", e.target.value)}
        />
      )}
      <div className="of-foot">
        <span className={tooLong ? "num err" : "num"}>
          {chars.toLocaleString("en-US")} characters
        </span>
        <span>· at most {MAX_OWNER_FILE_CHARS.toLocaleString("en-US")}</span>
        <span className="grow" />
        <span className="mono">~/.friday/config/{name}</span>
      </div>
      {!phone && (
        <SaveBar
          dirty={form.dirty}
          valid={!tooLong}
          saving={form.saving}
          onRevert={form.revert}
          onSave={save}
        />
      )}
    </SettingsPage>
  );
}

/** `/settings/owner/:file`: the USER.md or SOUL.md editor with a markdown preview. */
export function OwnerFileEditor({ file }: { file: keyof typeof FILES }) {
  const { key, title } = FILES[file];
  const q = useQuery(orpc.config.owner.get.queryOptions({ input: { file: key } }));
  if (!q.data) {
    return (
      <SettingsPage title={title}>
        <div className="empty" style={{ position: "relative" }}>
          <h3>{q.isError ? "Could not load the file." : "Loading…"}</h3>
        </div>
      </SettingsPage>
    );
  }
  return <EditorForm file={file} text={q.data.text} />;
}
