# Port: Surface

Where the owner talks to the bots (a chat app, a web app). Defined in `packages/core/src/ports/surface.ts`. The shipped adapter is `packages/surface-web` (`WebSurface`); the API in `packages/api` feeds it the owner's messages and answers.

## Interface

```ts
interface Surface {
  onMessage(handler: (m: InboundMessage) => Promise<number | undefined>): void; // resolves with the stored id
  post(conversationId, m: OutboundMessage): Promise<void>;
  askApproval(conversationId, card: ApprovalCard): Promise<"once" | "always" | "deny">;
  showActivity(conversationId, a: Activity): void;
  askQuestion(conversationId, card: QuestionCard): Promise<QuestionAnswer | null>;
  showRun(conversationId, botId, step: RunStep): void;
  postFile(conversationId, author, file: { path; name }, caption?): Promise<void>;
}

interface InboundMessage {
  conversationId; text;
  attachments?: Attachment[]; // files already saved on local disk
  replyTo?: number;           // id of the message this one replies to
  files?: FileRef[];          // the stored copies of the attachments
}
```

- A conversation is one bot's direct chat or one group. On the web surface its id is `bot:<id>` or `group:<id>`, created when the bot or group appears in the config.
- `onMessage` must deliver only the owner's messages (the web API requires the owner session). `InboundMessage.attachments` are files already saved on local disk, never remote URLs; `replyTo` is the id of an earlier message.
- `askApproval` resolves on the owner's choice. It must not resolve for anyone else, and must settle as `deny` when the card is cancelled or times out.
- `askQuestion` shows a bot's question and resolves with the owner's answer, or `null` when nobody answers in time.
- `showRun` shows one step of the bot's run in progress (thinking, tool, skill, MCP call, subagent, command); it is a live view, nothing is awaited.
- `post` sends bot text under the bot's name and `kind: "system"` text under the app's own name.
- `postFile` stores the file through the `FileStore` port (a `files` row plus a message that points to it), so history and reloads show it; the caller has already checked the path and size.

## Test with the fake

`packages/core/test/fakes/fake-surface.ts` records posts, files, approvals, questions and activity, and lets a test play the owner (`deliver`, `answerWith`). The web adapter is tested with the fake store and file store in `packages/surface-web/test/`.

## Add an adapter

1. Make `packages/surface-<name>/` with `src/index.ts`; depend on `@friday/core` only, plus the platform library in one adapter file. See `packages/surface-web/test/boundary.test.ts` for the scan to copy (no HTTP, env or console code in the adapter).
2. Put the platform behind a small interface of your own so tests need no network.
3. Implement `Surface`. Deliver only the owner's messages. Save files with a size and count cap, sanitise names, write under `<AGENT_HOME>/inbox/<conversationId>/`.
4. Add a boundary test.
5. Compose it in `apps/friday`.
