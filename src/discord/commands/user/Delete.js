import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import Users from "../../../User/Mongodb/Schema/user.js";
import Utils from "../../../Utils/Utils.js";
import log from "../../../Utils/log.js";
import { envBoolean, envInteger } from "../../../Config/env.js";
import {
  addBranding,
  requireAllowedCommandChannel,
  sendAuditWebhook,
} from "../../utils/discordUtils.js";

export const data = new SlashCommandBuilder()
  .setName("deleteaccount")
  .setDescription("Permanently delete your linked account")
  .setDMPermission(false);

export async function execute(interaction) {
  if (!(await requireAllowedCommandChannel(interaction))) return;

  if (!envBoolean("ACCOUNT_DELETION_ENABLED", true)) {
    return interaction.reply({ content: "Account deletion is currently disabled.", flags: MessageFlags.Ephemeral });
  }

  const account = await Users.findOne({ discordId: interaction.user.id });
  if (!account) {
    return interaction.reply({ content: "You do not have a linked account.", flags: MessageFlags.Ephemeral });
  }

  const confirmId = `delete:${interaction.id}:confirm`;
  const cancelId = `delete:${interaction.id}:cancel`;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(confirmId).setLabel("Delete permanently").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(cancelId).setLabel("Cancel").setStyle(ButtonStyle.Secondary)
  );

  const prompt = addBranding(
    new EmbedBuilder()
      .setTitle("Delete your account?")
      .setDescription(
        `This permanently removes **${account.username}**, its profiles, friends, and active sessions. This cannot be undone.`
      )
      .setTimestamp()
  );

  await interaction.reply({
    embeds: [prompt],
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
  const message = await interaction.fetchReply();

  const timeoutMs = envInteger("ACCOUNT_DELETE_CONFIRM_SECONDS", 60, { min: 15, max: 300 }) * 1000;

  try {
    const button = await message.awaitMessageComponent({
      filter: (candidate) => candidate.user.id === interaction.user.id,
      time: timeoutMs,
    });

    if (button.customId === cancelId) {
      return button.update({
        content: "Deletion cancelled. Your account was not changed.",
        embeds: [],
        components: [],
      });
    }

    if (button.customId !== confirmId) return;
    await button.deferUpdate();
    await Utils.DeleteAccountData(account.accountId);

    await sendAuditWebhook({
      title: "Account deleted",
      user: interaction.user,
      color: 0xd9534f,
      fields: [
        { name: "Username", value: account.username, inline: true },
        { name: "Account ID", value: account.accountId, inline: true },
        { name: "Discord ID", value: interaction.user.id, inline: true },
      ],
    });

    log.backend(`Account ${account.accountId} deleted by its owner ${interaction.user.id}`);
    return interaction.editReply({
      content: "Your account and associated backend data were permanently deleted.",
      embeds: [],
      components: [],
    });
  } catch (error) {
    if (error?.code === "InteractionCollectorError") {
      return interaction.editReply({
        content: "Deletion confirmation expired. Your account was not changed.",
        embeds: [],
        components: [],
      });
    }

    log.error(`Delete account command failed: ${error.message}`);
    return interaction.editReply({
      content: "Account deletion failed. Your account may still exist; check again before retrying.",
      embeds: [],
      components: [],
    });
  }
}
