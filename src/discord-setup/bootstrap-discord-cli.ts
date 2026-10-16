import { existsSync } from "node:fs";
import { ChannelType, Client, Events, GatewayIntentBits } from "discord.js";
import { loadConfig } from "../config/agent-config";
import { readProcessEnv } from "../config/process-env";
import { errText } from "../observability/redact";
import {
  type DiscordSetup,
  discordYamlPath,
  OPS_CATEGORY_NAME,
  OPS_CHANNEL_NAMES,
  type OpsChannels,
  writeDiscordSetup,
} from "./discord-setup-config";
import {
  botPermissionReport,
  type ChannelRef,
  createPrivate,
  listGuildChannels,
} from "./private-channels";

/** CLI output (stdout only; never secrets). */
const out = (line: string) => void process.stdout.write(`${line}\n`);

/** Every guild channel as `category / name / id` lines, categories first, so old channels can be reviewed. */
export function formatChannelList(
  channels: (ChannelRef & { parentId: string | null })[],
): string[] {
  const names = new Map(
    channels.filter((c) => c.type === ChannelType.GuildCategory).map((c) => [c.id, c.name]),
  );
  return channels
    .map((c) => ({ cat: c.parentId ? (names.get(c.parentId) ?? "?") : "(no category)", c }))
    .sort((a, b) => a.cat.localeCompare(b.cat) || a.c.name.localeCompare(b.c.name))
    .map(
      ({ cat, c }) =>
        `${cat} / ${c.type === ChannelType.GuildCategory ? "[category] " : ""}${c.name} / ${c.id}`,
    );
}

/** Log in with the Guilds intent only and resolve once ready. */
async function connect(token: string): Promise<Client> {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const ready = new Promise<void>((resolve) => client.once(Events.ClientReady, () => resolve()));
  await client.login(token);
  await ready;
  return client;
}

/** Entry: `bun run bootstrap:discord [--dry-run]`. Create-only; never deletes or edits anything. */
async function main(): Promise<number> {
  const dryRun = process.argv.includes("--dry-run");
  const config = loadConfig(readProcessEnv(), { requireDiscord: true });
  const token = config.discordToken ?? "";
  if (!config.discordGuildId) {
    out("DISCORD_GUILD_ID is required.");
    return 1;
  }
  // Refuse BEFORE creating anything: with an existing discord.yaml new ids could not be recorded.
  if (!dryRun && existsSync(discordYamlPath(config.agentHome))) {
    out(
      `${discordYamlPath(config.agentHome)} already exists. Nothing was created. Move it away (or delete the old ops channels by hand and the file) and rerun; use --dry-run to review.`,
    );
    return 1;
  }
  const client = await connect(token);
  try {
    const guild = await client.guilds.fetch(config.discordGuildId);
    const me = await guild.members.fetchMe();
    const report = botPermissionReport(me.permissions.bitfield);
    if (report.missing.length) {
      out(
        `The bot lacks guild permissions: ${report.missing.join(", ")}. Re-invite it with the URL in docs/discord-setup.md.`,
      );
      return 1;
    }
    if (report.administrator)
      out(
        "WARNING: the bot has Administrator. It bypasses channel overwrites, so private channels do not hide anything from it. Re-invite with least privilege.",
      );

    const existing = await listGuildChannels(guild);
    if (dryRun) {
      out("Existing channels (category / name / id):");
      for (const line of formatChannelList(existing)) out(`  ${line}`);
    }
    const ids = {
      guildId: guild.id,
      ownerId: config.ownerDiscordId ?? "",
      botId: client.user?.id ?? "",
    };
    const wanted = [
      { key: "categoryId" as const, name: OPS_CATEGORY_NAME, kind: "category" as const },
      ...(["control", "log", "health", "analytics"] as const).map((key) => ({
        key,
        name: OPS_CHANNEL_NAMES[key],
        kind: "text" as const,
      })),
    ];
    const ops: OpsChannels = {};
    let categoryId: string | undefined;
    let failed = false;
    for (const w of wanted) {
      const exists = existing.find(
        (c) =>
          c.name.toLowerCase() === w.name &&
          (w.kind === "category") === (c.type === ChannelType.GuildCategory),
      );
      if (dryRun) {
        out(`${exists ? "would refuse (exists)" : "would create"}: ${w.kind} ${w.name}`);
        continue;
      }
      if (w.kind === "text" && !categoryId) {
        out(
          `refused: ${w.name} (category ${OPS_CATEGORY_NAME} missing or not created by this run)`,
        );
        continue;
      }
      try {
        const r = await createPrivate(
          guild,
          existing,
          { name: w.name, kind: w.kind, parentId: categoryId },
          ids,
        );
        if (r.status === "created") ops[w.key] = r.id;
        if (w.kind === "category" && r.status === "created") categoryId = r.id;
        out(
          `${r.status === "created" ? "created" : "refused (exists; rename or delete it by hand)"}: ${w.name} ${r.id}`,
        );
      } catch (err) {
        failed = true;
        out(`FAILED: ${w.name}: ${scrub(errText(err), token)}`);
        break;
      }
    }
    if (dryRun) return 0;
    // Whatever was created is recorded, even after a failure, so no channel is lost.
    if (!Object.keys(ops).length) return failed ? 1 : 0;
    const setup: DiscordSetup = { ops, controlChannels: ops.control ? [ops.control] : [] };
    out(`wrote ${writeDiscordSetup(config.agentHome, setup)}`);
    if (failed)
      out(
        "Setup incomplete: fix the cause, delete the created ops channels by hand, remove discord.yaml, rerun.",
      );
    return failed ? 1 : 0;
  } finally {
    await client.destroy();
  }
}

/** Mask the token in a message; an empty token must not touch the text. */
export function scrub(text: string, token: string): string {
  return token ? text.replaceAll(token, "[REDACTED]") : text;
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      out(`bootstrap failed: ${scrub(errText(err), readProcessEnv().DISCORD_TOKEN ?? "")}`);
      process.exit(1);
    });
}
