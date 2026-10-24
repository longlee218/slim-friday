# Port: Surface

Where the owner talks to the bots (a chat app, a web app). Defined in `packages/core/src/ports/surface.ts`. The shipped adapter is `packages/surface-discord`.

## Interface

```ts
interface Surface {
  onMessage(handler: (m: InboundMessage) => void): void;
  post(conversationId, m: OutboundMessage): Promise<void>;
  postFile(conversationId, author, file: { path; name }, caption?): Promise<void>;
  askApproval(conversationId, card: ApprovalCard): Promise<"once" | "always" | "deny">;
  showActivity(conversationId, a: Activity): void;
}
```

- A conversation is one bot's direct chat or one group. Its id is whatever the surface uses for a place to talk (on Discord, the channel id).
- `onMessage` must deliver only the owner's messages. `InboundMessage.attachments` are files already saved on local disk, never remote URLs.
- `askApproval` resolves on the owner's choice. It must not resolve for anyone else, and must settle as `deny` when the card is cancelled or times out.
- `post` splits what the platform cannot send in one piece. Bot text goes out under the bot's name; `kind: "system"` text under the app's own name.

## Test with the fake

`packages/core/test/fakes/fake-surface.ts` records posts, files, approvals and activity, and lets a test play the owner (`deliver`, `answerWith`). The Discord adapter has its own `FakeDiscordPort` in `packages/surface-discord/test/`.

## Add an adapter

1. Make `packages/surface-<name>/` with `src/index.ts`; depend on `@friday/core` only, plus the platform library in one adapter file.
2. Put the platform behind a small port interface of your own (as `DiscordPort`) so tests need no network.
3. Implement `Surface`. Ignore bots, webhooks and every user but the owner. Download files with a size and count cap, sanitise names, write under `<AGENT_HOME>/inbox/<conversationId>/`.
4. Add a boundary test like `surface-discord/test/boundary.test.ts`.
5. Compose it in `apps/friday/src/start-app.ts`.
