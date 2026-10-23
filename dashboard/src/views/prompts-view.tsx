import { useState } from "react";
import { useApi } from "../api";
import { go, link } from "../router";
import { Load, Role, Share } from "../ui";

interface Scopes {
  roles: { name: string; model: string | null; kind: string; base: string }[];
  workspaces: { name: string; channels: string[] }[];
}
interface PromptData {
  role: {
    name: string;
    model: string | null;
    base: string;
    skills: string[];
    preloadSkills: string[];
    budgetUsd: number | null;
    limits: { maxAsk?: number; maxTurns?: number } | null;
    capabilities: string[];
  };
  layers: { name: string; chars: number; text: string }[];
  text: string;
  skills: { name: string; description: string }[];
  tools: { name: string; server: string | null; description: string; chars: number }[];
  externalTools: string[];
}

/** ~tokens the way the repo counts them: chars / 4. */
const tok = (chars: number) => `${(chars / 4 / 1000).toFixed(1)}k tok`;

/**
 * Exact system prompt of each role (what `bun run prompt:show` prints), for one workspace and channel: its layers in
 * order with their weight, the skills it is offered and the tools it gets. Built offline, no API call.
 */
export function PromptsView({ role, workspace, channel }: { role: string | null; workspace: string | null; channel: string | null }) {
  const scopes = useApi<Scopes>("prompts");
  const name = role ?? "chief-of-staff";
  const q = new URLSearchParams();
  if (workspace) q.set("workspace", workspace);
  if (channel) q.set("channel", channel);
  const prompt = useApi<PromptData>(`prompts/${name}${q.size ? `?${q}` : ""}`);
  const [copied, setCopied] = useState(false);
  const nav = (r: string, ws: string | null, ch: string | null) => go(link("prompts", r, { workspace: ws, channel: ch }));
  const channels = scopes.data?.workspaces.find((w) => w.name === workspace)?.channels ?? [];

  return (
    <div className="prompts">
      <nav className="role-list" aria-label="Roles">
        {scopes.data?.roles.map((r) => (
          <a key={r.name} href={link("prompts", r.name, { workspace, channel })} aria-current={r.name === name ? "page" : undefined}>
            <Role role={r.name} />
            <span className="faint">{r.model?.replace("claude-", "") ?? "–"}</span>
          </a>
        ))}
      </nav>
      <div className="prompt-main">
        <div className="toolbar">
          <label className="select">
            <span>Workspace</span>
            <select value={workspace ?? ""} onChange={(e) => nav(name, e.target.value || null, null)}>
              <option value="">none (placeholder)</option>
              {scopes.data?.workspaces.map((w) => <option key={w.name} value={w.name}>{w.name}</option>)}
            </select>
          </label>
          <label className="select">
            <span>Channel</span>
            <select value={channel ?? ""} disabled={!channels.length} onChange={(e) => nav(name, workspace, e.target.value || null)}>
              <option value="">all locations</option>
              {channels.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          {prompt.data && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                navigator.clipboard.writeText(prompt.data!.text).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1600);
                });
              }}
            >
              {copied ? "Copied" : "Copy prompt"}
            </button>
          )}
        </div>
        <Load state={prompt}>
          {(p) => {
            const total = p.layers.reduce((s, l) => s + l.chars, 0);
            const toolChars = p.tools.reduce((s, t) => s + t.chars, 0);
            const max = Math.max(1, ...p.layers.map((l) => l.chars));
            return (
              <>
                <dl className="facts-line">
                  <div><dt>System prompt</dt><dd>{tok(total)}</dd><small>{total.toLocaleString()} chars</small></div>
                  <div><dt>Tools</dt><dd>{p.tools.length + p.externalTools.length}</dd><small>{tok(toolChars)}</small></div>
                  <div><dt>Skills offered</dt><dd>{p.skills.length}</dd><small>{p.role.preloadSkills.length} preloaded</small></div>
                  <div><dt>Base</dt><dd>{p.role.base}</dd><small>{p.role.model ?? "–"}</small></div>
                  <div><dt>Limits</dt><dd>{p.role.limits?.maxTurns ?? "–"} turns</dd><small>{p.role.budgetUsd != null ? `$${p.role.budgetUsd} budget` : "no budget"}</small></div>
                </dl>

                <section className="section">
                  <header><h2>Layers</h2><span className="muted">in prompt order · open one to read it</span></header>
                  <div className="layers">
                    {p.layers.map((l, i) => (
                      <details key={`${l.name}-${i}`} className="layer">
                        <summary>
                          <span className="num faint">{i + 1}</span>
                          <span className="layer-name">{l.name}</span>
                          <Share value={l.chars / max} label={tok(l.chars)} />
                        </summary>
                        <pre>{l.text}</pre>
                      </details>
                    ))}
                  </div>
                </section>

                <div className="split">
                  <section className="section">
                    <header><h2>Skills offered</h2><span className="muted">{p.skills.length}</span></header>
                    <ul className="plain-list">
                      {p.skills.map((s) => (
                        <li key={s.name}>
                          <span className="mono">{s.name}</span>
                          {p.role.preloadSkills.some((x) => s.name.endsWith(x)) && <span className="tag">preloaded</span>}
                          <div className="sub clip">{s.description}</div>
                        </li>
                      ))}
                    </ul>
                  </section>
                  <section className="section">
                    <header><h2>Tools</h2><span className="muted">{tok(toolChars)} of definitions</span></header>
                    <ul className="plain-list">
                      {p.tools.map((t) => (
                        <li key={`${t.server}-${t.name}`} className="tool-li">
                          <span className="mono">{t.name}</span>
                          <span className="faint">{t.server ?? "built-in"}</span>
                          <span className="num faint">{tok(t.chars)}</span>
                        </li>
                      ))}
                      {p.externalTools.map((t) => (
                        <li key={t} className="tool-li">
                          <span className="mono">{t}</span>
                          <span className="faint">external</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                </div>
              </>
            );
          }}
        </Load>
      </div>
    </div>
  );
}
