import {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import Users from "../../../User/Mongodb/Schema/user.js";
import log from "../../../Utils/log.js";
import {
  addBranding,
  safeDm,
  sendAuditWebhook,
  requireAllowedCommandChannel,
  requireModerator,
} from "../../utils/discordUtils.js";

export const data = new SlashCommandBuilder()
  .setName("unban")
  .setDescription("Unban a linked backend account")
  .addUserOption((option) =>
    option
      .setName("user")
      .setDescription("Discord user whose backend account should be unbanned")
      .setRequired(true)
  )
  .addStringOption((option) =>
    option
      .setName("reason")
      .setDescription("Reason for the unban")
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
    if (!account.banned) {
      return interaction.editReply(`**${account.username}** is not banned.`);
    }

    account.banned = false;
    await account.save();

    const dmDelivered = await safeDm(discordUser, {
      content: `Your ${process.env.BACKEND_NAME || "backend"} account has been unbanned.`,
    });

    const embed = addBranding(
      new EmbedBuilder()
        .setTitle("Account unbanned")
        .setDescription(`**${account.username}** has been unbanned.`)
        .addFields(
          { name: "Discord user", value: `<@${discordUser.id}>`, inline: true },
          { name: "Reason", value: reason, inline: false },
          { name: "DM delivered", value: dmDelivered ? "Yes" : "No", inline: true }
        )
        .setTimestamp()
    );

    await sendAuditWebhook({
      title: "Account unbanned",
      user: discordUser,
      color: 0x57f287,
      fields: [
        { name: "Username", value: account.username, inline: true },
        { name: "Account ID", value: account.accountId, inline: true },
        { name: "Moderator", value: `${interaction.user.tag} (${interaction.user.id})` },
        { name: "Reason", value: reason },
      ],
    });

    log.backend(`Account ${account.accountId} unbanned by ${interaction.user.id}: ${reason}`);
    return interaction.editReply({ embeds: [embed] });
  } catch (error) {
    log.error(`Unban command failed: ${error.message}`);
    return interaction.editReply("The account could not be unbanned because of an internal error.");
  }
}
