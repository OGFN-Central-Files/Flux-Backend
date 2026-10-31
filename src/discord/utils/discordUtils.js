import axios from "axios";
import { EmbedBuilder, MessageFlags } from "discord.js";
import { envBoolean, envList, envString } from "../../Config/env.js";
import log from "../../Utils/log.js";

export const brandName = () => envString("BACKEND_NAME", "Flux");
export const brandColor = () => envString("DISCORD_EMBED_COLOR", "#9370DB");
export const brandIcon = () => envString("DISCORD_BRAND_ICON_URL", "");

export function addBranding(embed) {
  const iconURL = brandIcon();
  embed.setColor(brandColor()).setFooter(
    iconURL ? { text: brandName(), iconURL } : { text: brandName() }
  );
  return embed;
}

export function isAllowedCommandChannel(interaction) {
  const allowed = envList("COMMAND_CHANNEL_IDS");
  const legacy = envString("COMMAND_CHANNEL_ID");
  if (legacy && !allowed.includes(legacy)) allowed.push(legacy);
  return allowed.length === 0 || allowed.includes(interaction.channelId);
}

export function allowedChannelMessage() {
  const allowed = envList("COMMAND_CHANNEL_IDS");
  const legacy = envString("COMMAND_CHANNEL_ID");
  if (legacy && !allowed.includes(legacy)) allowed.push(legacy);
  if (allowed.length === 0) return "This command is not available in this channel.";
  return `Use this command in ${allowed.map((id) => `<#${id}>`).join(" or ")}.`;
}


export async function requireAllowedCommandChannel(interaction) {
  if (isAllowedCommandChannel(interaction)) return true;
  const payload = { content: allowedChannelMessage(), flags: MessageFlags.Ephemeral };
  if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
  else await interaction.reply(payload);
  return false;
}

export function isConfiguredModerator(userId) {
  const moderatorIds = envList("MODERATOR_USER_IDS");
  return moderatorIds.length > 0 && moderatorIds.includes(String(userId));
}

export async function requireModerator(interaction) {
  if (isConfiguredModerator(interaction.user.id)) return true;
  const payload = {
    content: "You are not configured as a launcher moderator.",
    flags: MessageFlags.Ephemeral,
  };
  if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
  else await interaction.reply(payload);
  return false;
}

export function memberHasConfiguredRole(interaction, envName, { allowWhenEmpty = false } = {}) {
  const roleIds = envList(envName);
  if (roleIds.length === 0) return allowWhenEmpty;
  const cache = interaction.member?.roles?.cache;
  return Boolean(cache && roleIds.some((roleId) => cache.has(roleId)));
}

export async function safeDm(user, payload) {
  try {
    await user.send(payload);
    return true;
  } catch (error) {
    log.warn(`Unable to DM Discord user ${user.id}: ${error.message}`);
    return false;
  }
}

export async function sendAuditWebhook({ title, description = "", fields = [], color = 0x9370db, user = null }) {
  const webhook = envString("LOG_WEBHOOK");
  if (!webhook || !envBoolean("ENABLE_LOG_WEBHOOK", true)) return false;

  const cleanFields = fields
    .filter((field) => field?.name && field?.value !== undefined)
    .slice(0, 25)
    .map((field) => ({
      name: String(field.name).slice(0, 256),
      value: String(field.value).slice(0, 1024),
      inline: Boolean(field.inline),
    }));

  const embed = {
    title: String(title).slice(0, 256),
    description: String(description).slice(0, 4096),
    color,
    fields: cleanFields,
    timestamp: new Date().toISOString(),
    footer: { text: brandName() },
  };

  if (user) {
    embed.thumbnail = { url: user.displayAvatarURL({ extension: "png", size: 128 }) };
  }

  try {
    await axios.post(webhook, { embeds: [embed] }, { timeout: 5000 });
    return true;
  } catch (error) {
    log.warn(`Discord audit webhook failed: ${error.message}`);
    return false;
  }
}

export function resultEmbed(title, description, { success = true } = {}) {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setTimestamp();
  addBranding(embed);
  if (!success) embed.setColor("#D9534F");
  return embed;
}
