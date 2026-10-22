import type { Turn } from "../api";
import { useApi } from "../api";
import { dur, tokens, usd, when } from "../format";
import { go, link } from "../router";
import { Load, Role, roleColor, Section, Share, Stats } from "../ui";
import { CostDayChart, type DayRow } from "./cost-day-chart";

interface CostData {
  totals: {
    runs: number;
    cost_usd: number;
    sdk_turns: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    not_success: number;
  };
  byDay: DayRow[];
  byRole: { role: string; runs: number; cost_usd: number; avg_cost: number; sdk_turns: number; avg_turns: number; avg_ms: number; in_tokens: number; output_tokens: number; not_success: number }[];
  byModel: { model: string; runs: number; cost_usd: number }[];
  byTool: { tool: string; calls: number; errors: number; avg_ms: number; total_ms: number }[];
  topRuns: Turn[];
}

/** Where the money and tokens went: per day, role, model and tool, and the most expensive runs. */
export function CostView() {
  const state = useApi<CostData>("cost", true);
  return (
    <Load state={state} isEmpty={(d) => !d.totals.runs} empty="No runs in this window.">
      {({ totals, byDay, byRole, byModel, byTool, topRuns }) => {
        const allIn = totals.input_tokens + totals.cache_read_tokens + totals.cache_creation_tokens;
        const maxRole = Math.max(0.01, ...byRole.map((r) => r.cost_usd));
        const maxModel = Math.max(0.01, ...byModel.map((m) => m.cost_usd));
        const maxToolMs = Math.max(1, ...byTool.map((t) => t.total_ms));
        return (
          <>
            <Stats
              items={[
                ["Cost", usd(totals.cost_usd)],
                ["Runs", totals.runs],
                ["Avg per run", usd(totals.cost_usd / Math.max(1, totals.runs))],
                ["SDK turns", totals.sdk_turns.toLocaleString()],
                ["Output tokens", tokens(totals.output_tokens)],
                ["Input tokens", <>{tokens(allIn)} <small>{Math.round((totals.cache_read_tokens / Math.max(1, allIn)) * 100)}% cached</small></>],
                ["Not success", totals.not_success, totals.not_success > 0],
              ]}
            />
            <Section title="Cost per day" note="stacked by role · hover a day for the split">
              <CostDayChart rows={byDay} />
            </Section>
            <Section title="By role">
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Role</th>
                      <th>Cost</th>
                      <th className="r">Runs</th>
                      <th className="r">Avg / run</th>
                      <th className="r">Avg turns</th>
                      <th className="r">Avg time</th>
                      <th className="r">Input</th>
                      <th className="r">Output</th>
                      <th className="r">Not success</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byRole.map((r) => (
                      <tr key={r.role}>
                        <td><Role role={r.role} /></td>
                        <td style={{ width: "26%" }}>
                          <Share value={r.cost_usd / maxRole} label={usd(r.cost_usd)} color={roleColor(r.role)} />
                        </td>
                        <td className="r">{r.runs}</td>
                        <td className="r">{usd(r.avg_cost)}</td>
                        <td className="r">{r.avg_turns?.toFixed(1)}</td>
                        <td className="r">{dur(r.avg_ms)}</td>
                        <td className="r">{tokens(r.in_tokens)}</td>
                        <td className="r">{tokens(r.output_tokens)}</td>
                        <td className={`r${r.not_success ? " bad-text" : " faint"}`}>{r.not_success}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
            <div className="split">
              <Section title="Most expensive runs" note="open in its thread">
                <div className="table-wrap">
                  <table>
                    <tbody>
                      {topRuns.map((t) => (
                        <tr key={t.id} className="click" onClick={() => go(link("threads", t.thread_id, { run: t.id }))}>
                          <td>
                            <Role role={t.role} />
                            {t.item_key && <span className="mono faint"> · {t.item_key}</span>}
                          </td>
                          <td className="num muted">{when(t.started_at)}</td>
                          <td className="r muted">{t.sdk_turns} turns</td>
                          <td className="r"><strong>{usd(t.cost_usd)}</strong></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Section>
              <Section title="By model">
                <div className="table-wrap">
                  <table>
                    <tbody>
                      {byModel.map((m) => (
                        <tr key={m.model}>
                          <td className="mono">{m.model}</td>
                          <td className="r muted">{m.runs} runs</td>
                          <td style={{ width: "45%" }}><Share value={m.cost_usd / maxModel} label={usd(m.cost_usd)} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Section>
            </div>
            <Section title="Tools" note="where run time goes, and which tools fail">
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Tool</th>
                      <th>Total time</th>
                      <th className="r">Calls</th>
                      <th className="r">Avg</th>
                      <th className="r">Failed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byTool.map((t) => (
                      <tr key={t.tool}>
                        <td className="mono">{t.tool.replace(/^mcp__\w+?__/, "")}</td>
                        <td style={{ width: "34%" }}><Share value={t.total_ms / maxToolMs} label={dur(t.total_ms)} /></td>
                        <td className="r">{t.calls}</td>
                        <td className="r">{dur(t.avg_ms)}</td>
                        <td className={`r${t.errors ? " bad-text" : " faint"}`}>
                          {t.errors ? `${t.errors} · ${Math.round((t.errors / t.calls) * 100)}%` : "0"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          </>
        );
      }}
    </Load>
  );
}
