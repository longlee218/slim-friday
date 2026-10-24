# Port: AgentRuntime

Runs one bot as a long-lived session. Defined in `packages/core/src/ports/agent-runtime.ts`. The shipped adapter is `packages/runtime-claude` (Claude Agent SDK).

## Interface

```ts
interface AgentRuntime {
  open(spec: BotRuntimeSpec): Promise<BotSession>;
  resume(sessionId: string, spec: BotRuntimeSpec): Promise<BotSession>;
}
interface BotSession {
  id: string;
  send(turn: InboundTurn): void;
  events: AsyncIterable<RuntimeEvent>;
  stop(): Promise<void>;
}
```

- `BotRuntimeSpec` carries the bot, `decide(call)` (the permission gate: ask it before every tool call the runtime cannot settle itself), `currentConversation()` and the bot's memory text.
- `send` takes one turn at a time; the hub queues a message for a busy bot. A turn may carry `attachments` (saved local files) and `groupMemory`.
- `events` uses generic words: `text`, `tool_call`, `task_started`, `task_done`, `turn_end` (with cost), `compacted`, `error`. A failed stream should throw from `events` so the hub can resume.
- `resume` must throw when the stored session is gone; the hub then opens a fresh session.
- `stop` ends the session and every background task it started.

## Test with the fake

`packages/core/test/fakes/fake-runtime.ts`: a scripted session you drive with `emit`, `end` and `fail`. For the Claude adapter, `packages/runtime-claude/test/fake-query.ts` replaces the SDK `query`.

## Add an adapter

1. Make `packages/runtime-<name>/`; depend on `@friday/core` and your SDK only. Never read `process.env`: take the env as an argument.
2. Own the safety floor in code: deny file access outside the bot's dirs, inside the agent home and on secret files, before `decide` is asked; scrub the child env.
3. Map the vendor's messages to `RuntimeEvent`. Keep vendor words out of core.
4. Add a boundary test and compose it in `apps/friday/src/main.ts`.
