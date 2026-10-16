import type { Database } from "bun:sqlite";
import type { Message } from "discord.js";
import type { ApprovalGateway } from "../approvals/approval-types";
import { slashToLegacy } from "../commands/slash-commands";
import type { AgentConfig } from "../config/agent-config";
import { sendReply, startTyping } from "../ingress/discord-send";
import {
  detectLanguage,
  languageOf,
  pinnedThreadLanguage,
  pinThreadLanguage,
  renderUserNotice,
} from "../ingress/user-copy";
import { createDiscordAdminServer } from "../mcp/discord-admin-server";
import { DISCORD_ADMIN_MCP_SERVER } from "../mcp/mcp-tool-names";
import { logEvent, logger, runWithLogContext } from "../observability/logger";
import { errText } from "../observability/redact";
import { ownerConfirm } from "../orchestrator/engine/owner-confirm";
import { runRole } from "../orchestrator/engine/run-role";
import { finishRun, RESUMABLE_OUTCOMES } from "../orchestrator/turns/turn-result";
import { controlRole } from "../roles/role-registry";
import type { QueryFn } from "../runtime/run-agent";
import { finishTurn, insertTurn } from "../storage/run-store";
import { getSession, setSession } from "../storage/session-store";
import type { InitDeps } from "./init-workspace";

const log = logger.child({ module: "control-role-run" });

/** What the control-channel runner needs. */
export interface ControlRunDeps {
  db: Database;
  config: AgentConfig;
  /** Owner buttons (questions, diff confirmations); absent = every confirmation is a no. */
  approvals?: ApprovalGateway;
  /** Override the SDK query (tests). */
  queryFn?: QueryFn;
}

/** Handles one owner message of the control channel; true when the role took it (false = no control role registered). */
export interface ControlRun {
  (msg: Message, prompt: string, init: InitDeps): Promise<boolean>;
  /** Shutdown: abort every control run in flight. */
  abortAll(): void;
  /** Shutdown: abort, wait for the runs to end (at most `ms`) and return the time left. */
  drain(ms: number): Promise<number>;
}

/** A stored control session idle for longer than this is dropped: the next message starts a fresh one. */
export const CONTROL_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Run the control-channel role (found by its `surface` data, never by name) for the owner's non-command text in
 * #ops-control. The caller already passed the admin gate (owner, pinned guild, control channel, live privacy). One
 * session per control channel (`threadId` = channel id, like a `chat` channel), inline replies, no workspace. One run
 * at a time per channel; `stop` aborts it. The discord-admin server is built per run with the guild and the
 * owner-confirm relay, so the agent has no token: only the role's tools reach Discord and the space files.
 */
export function createControlRoleRun(deps: ControlRunDeps): ControlRun {
  const { db, config } = deps;
  /** Channels with a run in flight -> its controller and a promise that settles when the run has fully ended. */
  const running = new Map<string, { ac: AbortController; ended: Promise<void> }>();
  const run = async (msg: Message, prompt: string, init: InitDeps): Promise<boolean> => {
    const role = controlRole();
    const channel = msg.channel;
    const { approvals } = deps;
    // No role, or no button flow (an ask and every confirmation would be a no): the caller shows the help text.
    if (!role || !approvals || !channel.isSendable()) return false;
    const channelId = channel.id;
    const active = running.get(channelId)?.ac;
    if (slashToLegacy(prompt).trim().toLowerCase() === "stop") {
      active?.abort();
      await channel.send(active ? "Stopping." : "Nothing is running.");
      return true;
    }
    if (active) {
      await channel.send("The previous request is still running. Send `stop` to abort it.");
      return true;
    }
    const ac = new AbortController();
    let ended!: () => void;
    running.set(channelId, { ac, ended: new Promise<void>((r) => (ended = r)) });
    const turnId = crypto.randomUUID();
    const language =
      detectLanguage(prompt) ?? pinnedThreadLanguage(channelId) ?? languageOf(prompt);
    pinThreadLanguage(channelId, language);
    const stopTyping = startTyping(channel);
    let turnOpen = false;
    try {
      await runWithLogContext(
        { taskId: turnId, threadId: channelId, channelId, mode: role.name },
        async () => {
          insertTurn(db, {
            id: turnId,
            threadId: channelId,
            source: "discord",
            location: "*",
            role: role.name,
          });
          turnOpen = true;
          // A session idle for over a day is not resumed (a fresh one starts; the old row is overwritten on save).
          const stored = getSession(db, channelId);
          const existing =
            stored && Date.now() - stored.updated_at <= CONTROL_SESSION_MAX_AGE_MS ? stored : null;
          const res = await runRole(
            { db, config, approvals, queryFn: deps.queryFn },
            {
              turnId,
              threadId: channelId,
              channelId,
              channelMode: "chat",
              text: prompt,
              role: role.name,
              locations: [],
              ac,
              language,
              existing,
              // Built per query() call: an in-process server instance is never shared by two calls.
              appServers: () => ({
                [DISCORD_ADMIN_MCP_SERVER]: createDiscordAdminServer({
                  home: config.agentHome,
                  db,
                  init,
                  confirm: (q) =>
                    ownerConfirm(approvals, {
                      kind: q.kind,
                      turnId,
                      threadId: channelId,
                      summary: q.summary,
                      detail: q.detail,
                      language,
                      signal: ac.signal,
                    }),
                }),
              }),
            },
          );
          if (res.sessionId && res.cwd && RESUMABLE_OUTCOMES.has(res.outcome))
            setSession(db, {
              threadId: channelId,
              sessionId: res.sessionId,
              location: "*",
              cwd: res.cwd,
            });
          turnOpen = false;
          // The session is saved above; finishRun closes the turn row and words the reply (budget stop, failure notice).
          const text = finishRun(
            db,
            { turnId, threadId: channelId },
            { ...res, skipThreadSession: true },
            language,
          );
          logEvent(log, "control.run_finished", { outcome: res.outcome });
          await sendReply(channel, text, language);
        },
      );
    } catch (err) {
      log.error({ err: errText(err) }, "control run failed");
      if (turnOpen) finishTurn(db, turnId, ac.signal.aborted ? "cancelled" : "failed");
      await channel
        .send(renderUserNotice({ kind: "failure" }, language))
        .catch((e: unknown) => log.warn({ err: errText(e) }, "control failure notice failed"));
    } finally {
      stopTyping();
      running.delete(channelId);
      ended();
    }
    return true;
  };
  /** Abort every run in flight; an aborted run closes its turn row as `cancelled` (never resumable). */
  const abortAll = () => {
    for (const { ac } of running.values()) ac.abort();
  };
  return Object.assign(run, {
    abortAll,
    async drain(ms: number): Promise<number> {
      const t0 = Date.now();
      const all = [...running.values()].map((r) => r.ended);
      abortAll();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all(all),
        new Promise((r) => {
          timer = setTimeout(r, ms);
        }),
      ]);
      clearTimeout(timer);
      return Math.max(0, ms - (Date.now() - t0));
    },
  });
}
