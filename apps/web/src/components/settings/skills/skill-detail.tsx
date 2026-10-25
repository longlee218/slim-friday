import type { SkillDto } from "@friday/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { client, orpc } from "../../../api/client";
import { useDirectory } from "../../../api/directory";
import { BotMarkdown } from "../../markdown/bot-markdown";
import { Button } from "../../ui/button";
import { Sheet } from "../../ui/sheet";
import { saveFailure } from "../field-error";
import { Row } from "../form-parts";
import { PhoneRemoveRow } from "../phone-remove-row";
import { SettingsPage } from "../settings-page";
import { refreshSkills } from "./install-skill-sheet";
import { SkillBanner } from "./skill-banner";
import { SkillUsedBy } from "./skill-used-by";

/** The confirm dialog of Remove: names the bots that lose the skill. */
function RemoveSheet({
  skill,
  open,
  onOpenChange,
}: {
  skill: SkillDto;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const dir = useDirectory();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const who = skill.usedBy.map((id) => dir.botName(id));
  const remove = async () => {
    try {
      await client.config.skills.remove({ name: skill.name });
      await refreshSkills(qc);
      toast(`${skill.name} removed.`);
      void navigate("/settings/skills", { replace: true });
    } catch (e) {
      toast.error(saveFailure(e).message);
    }
  };
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <h3>Remove {skill.name}?</h3>
      <p style={{ color: "var(--label-2)", margin: "6px 0 14px" }}>
        {who.length ? `${who.join(", ")} lose it from their next session.` : "No bot uses it."} The
        files are deleted from the config folder.
      </p>
      <div className="acts">
        <Button onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant="danger" onClick={() => void remove()}>
          Remove skill
        </Button>
      </div>
    </Sheet>
  );
}

/** The body of one skill. Keyed by name so state resets. */
function Loaded({ skill }: { skill: SkillDto }) {
  const [removing, setRemoving] = useState(false);
  return (
    <SettingsPage title={skill.name}>
      <div className="page-head">
        <Link className="ib" to="/settings/skills" aria-label="Back to skills">
          <ChevronLeft size={16} strokeWidth={1.75} />
        </Link>
        <div className="grow">
          <h2 className="mono">{skill.name}</h2>
          <div className="r">{skill.description}</div>
        </div>
        {!skill.shipped && (
          <Button variant="danger" onClick={() => setRemoving(true)}>
            <Trash2 size={14} strokeWidth={1.75} />
            Remove
          </Button>
        )}
      </div>
      <SkillBanner skill={skill} />
      <div className="formgroup">
        {skill.source && (
          <Row label="Source">
            <span className="mono">{skill.source}</span>
          </Row>
        )}
        {!skill.shipped && skill.installedAt && (
          <Row label="Installed">
            <span>
              {new Date(skill.installedAt).toLocaleDateString("en-US", { dateStyle: "medium" })}
              {skill.sha && (
                <>
                  {" · "}
                  <span className="mono">{skill.sha.slice(0, 7)}</span>
                </>
              )}
            </span>
          </Row>
        )}
        <Row label="Files" top>
          <div className="toks">
            {skill.files.map((f) => (
              <span className="tok" key={f}>
                {f}
              </span>
            ))}
          </div>
        </Row>
      </div>
      <SkillUsedBy name={skill.name} usedBy={skill.usedBy} />
      <h3 style={{ fontSize: 13, margin: "0 0 8px" }}>SKILL.md</h3>
      <div className="list-panel skill-body">
        {/* Third-party text: BotMarkdown renders no raw HTML. */}
        <BotMarkdown text={skill.body} />
      </div>
      {!skill.shipped && (
        <PhoneRemoveRow label="Remove this skill" onClick={() => setRemoving(true)} />
      )}
      <RemoveSheet skill={skill} open={removing} onOpenChange={setRemoving} />
    </SettingsPage>
  );
}

/** `/settings/skills/:name`: one skill. */
export function SkillDetail() {
  const { name = "" } = useParams();
  const q = useQuery(orpc.config.skills.list.queryOptions());
  const skill = q.data?.find((s) => s.name === name);
  if (!skill) {
    return (
      <SettingsPage title="Skill">
        <div className="empty">
          <h3>{q.data ? "This skill does not exist." : "Loading…"}</h3>
        </div>
      </SettingsPage>
    );
  }
  return <Loaded key={skill.name} skill={skill} />;
}
