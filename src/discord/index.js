import "dotenv/config";
import {
  ActivityType,
  Client,
  Collection,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
} from "discord.js";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Users from "../User/Mongodb/Schema/user.js";
import Utils from "../Utils/Utils.js";
import log from "../Utils/log.js";
import { envBoolean, envInteger, envString } from "../Config/env.js";
import { deployCommands } from "./deploy-commands.js";

export const client = new Client({
  partials: [Partials.Channel],
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.DirectMessages,
  ],
  presence: { status: "online", activities: [] },
});

global.discordClient = client;
client.commands = new Collection();

async function loadCommands() {
  const foldersPath = path.join(process.cwd(), "src", "discord", "commands");
  if (!fs.existsSync(foldersPath)) throw new Error(`Discord commands folder not found: ${foldersPath}`);

  for (const folder of fs.readdirSync(foldersPath, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    const commandsPath = path.join(foldersPath, folder.name);

    for (const file of fs.readdirSync(commandsPath)) {
      if (!file.endsWith(".js")) continue;
      try {
        const command = await import(pathToFileURL(path.join(commandsPath, file)).href);
        if (!command.data?.name || typeof command.execute !== "function") {
          log.warn(`Discord command ${folder.name}/${file} is missing data or execute.`);
          continue;
        }
        client.commands.set(command.data.name, command);
      } catch (error) {
        log.error(`Failed to load Discord command ${folder.name}/${file}: ${error.stack || error.message}`);
      }
    }
  }

  log.bot(`Loaded ${client.commands.size} Discord commands.`);
}

await loadCommands();

let previousPlayerCount = null;
let statusTimer = null;

function statusActivityType() {
  const requested = envString("DISCORD_STATUS_TYPE", "Watching").toLowerCase();
  return {
    playing: ActivityType.Playing,
    streaming: ActivityType.Streaming,
    listening: ActivityType.Listening,
    watching: ActivityType.Watching,
    competing: ActivityType.Competing,
  }[requested] ?? ActivityType.Watching;
}

async function refreshStatus() {
  const xmppPort = envInteger("XMPP_PORT", 80, { min: 1, max: 65535 });
  try {
    const response = await fetch(`http://127.0.0.1:${xmppPort}`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const playerCount = Number(data?.Clients?.amount ?? 0);
    if (playerCount === previousPlayerCount) return;

    const template = envString("DISCORD_STATUS_TEXT", "{players} player{plural} online");
    const name = template
      .replaceAll("{players}", String(playerCount))
      .replaceAll("{plural}", playerCount === 1 ? "" : "s");

    client.user?.setPresence({
      activities: [{ name, type: statusActivityType() }],
      status: envString("DISCORD_STATUS", "online"),
    });
    previousPlayerCount = playerCount;
  } catch (error) {
    log.debug(`Discord status refresh skipped: ${error.message}`);
  }
}

client.once(Events.ClientReady, async (readyClient) => {
  global.clientId = readyClient.application.id;
  global.discordApplication = readyClient.application;
  log.bot(`Logged in as ${readyClient.user.tag}.`);

  if (envBoolean("DISCORD_AUTO_DEPLOY_COMMANDS", true)) {
    try {
      await deployCommands(readyClient.application.id);
    } catch (error) {
      log.error(`Discord command deployment failed: ${error.stack || error.message}`);
    }
  }

  if (envBoolean("DISCORD_DYNAMIC_STATUS_ENABLED", true)) {
    await refreshStatus();
    const interval = envInteger("DISCORD_STATUS_INTERVAL_SECONDS", 15, { min: 5, max: 3600 });
    statusTimer = setInterval(refreshStatus, interval * 1000);
    statusTimer.unref?.();
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const command = client.commands.get(interaction.commandName);
  if (!command) {
    return interaction.reply({ content: "This command is not available.", flags: MessageFlags.Ephemeral });
  }

  try {
    await command.execute(interaction);
  } catch (error) {
    log.error(`Discord command /${interaction.commandName} failed: ${error.stack || error.message}`);
    const payload = { content: "There was an internal error while running this command.", flags: MessageFlags.Ephemeral };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
});

client.on(Events.GuildBanAdd, async (ban) => {
  if (!envBoolean("SYNC_GUILD_BANS", true) || ban.user.bot) return;
  try {
    const account = await Users.findOne({ discordId: ban.user.id });
    if (!account || account.banned) return;
    account.banned = true;
    await account.save();
    await Utils.RevokeAccountSessions(account.accountId);
    log.bot(`Backend account ${account.accountId} was banned after a Discord guild ban.`);
  } catch (error) {
    log.error(`Guild ban synchronization failed: ${error.message}`);
  }
});

client.on(Events.GuildBanRemove, async (ban) => {
  if (!envBoolean("SYNC_GUILD_BANS", true) || ban.user.bot) return;
  try {
    const account = await Users.findOne({ discordId: ban.user.id });
    if (!account || !account.banned) return;
    account.banned = false;
    await account.save();
    log.bot(`Backend account ${account.accountId} was unbanned after a Discord guild unban.`);
  } catch (error) {
    log.error(`Guild unban synchronization failed: ${error.message}`);
  }
});

client.on(Events.Error, (error) => {
  log.error(`Discord client error: ${error.stack || error.message}`);
});
