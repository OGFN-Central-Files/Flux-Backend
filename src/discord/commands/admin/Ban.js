import {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import Users from "../../../User/Mongodb/Schema/user.js";
import Utils from "../../../Utils/Utils.js";
import log from "../../../Utils/log.js";
import {
  addBranding,
  safeDm,
  sendAuditWebhook,
  requireAllowedCommandChannel,
  requireModerator,
} from "../../utils/discordUtils.js";

export const data = new SlashCommandBuilder()
  .setName("ban")
  .setDescription("Ban a linked backend account")
  .addUserOption((option) =>
    option
      .setName("user")
      .setDescription("Discord user whose backend account should be banned")
      .setRequired(true)
  )
  .addStringOption((option) =>
    option
      .setName("reason")
      .setDescription("Reason for the ban")
      .setMaxLength(500)
      .setRequired(true)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
  .setDMPermission(false);

export async function execute(interaction) {
  if (!(await requireModerator(interaction))) return;
  if (!(await requireAllowedCommandChannel(interaction))) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const discordUser = interaction.options.getUser("user", true);
  const reason = interaction.options.getString("reason", true).trim();

  try {
    const account = await Users.findOne({ discordId: discordUser.id });
    if (!account) {
      return interaction.editReply("That Discord user does not have a linked backend account.");
    }
    if (account.banned) {
      return interaction.editReply(`**${account.username}** is already banned.`);
    }

    account.banned = true;
    await account.save();
    await Utils.RevokeAccountSessions(account.accountId);

    const dmDelivered = await safeDm(discordUser, {
      content: `Your ${process.env.BACKEND_NAME || "backend"} account has been banned.\n\n**Reason:** ${reason}`,
    });

    const embed = addBranding(
      new EmbedBuilder()
        .setTitle("Account banned")
        .setDescription(`**${account.username}** has been banned.`)
        .addFields(
          { name: "Discord user", value: `<@${discordUser.id}>`, inline: true },
          { name: "Reason", value: reason, inline: false },
          { name: "DM delivered", value: dmDelivered ? "Yes" : "No", inline: true }
        )
        .setTimestamp()
    );

    await sendAuditWebhook({
      title: "Account banned",
      user: discordUser,
      color: 0xd9534f,
      fields: [
        { name: "Username", value: account.username, inline: true },
        { name: "Account ID", value: account.accountId, inline: true },
        { name: "Moderator", value: `${interaction.user.tag} (${interaction.user.id})` },
        { name: "Reason", value: reason },
      ],
    });

    log.backend(`Account ${account.accountId} banned by ${interaction.user.id}: ${reason}`);
    return interaction.editReply({ embeds: [embed] });
  } catch (error) {
    log.error(`Ban command failed: ${error.message}`);
    return interaction.editReply("The account could not be banned because of an internal error.");
  }
}
