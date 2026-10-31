import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from "discord.js";
import Users from "../../../User/Mongodb/Schema/user.js";
import Utils from "../../../Utils/Utils.js";
import log from "../../../Utils/log.js";
import { envBoolean, envInteger } from "../../../Config/env.js";
import {
  addBranding,
  memberHasConfiguredRole,
  requireAllowedCommandChannel,
  sendAuditWebhook,
} from "../../utils/discordUtils.js";

export const data = new SlashCommandBuilder()
  .setName("username")
  .setDescription("Change your linked account username")
  .addStringOption((option) =>
    option
      .setName("username")
      .setDescription("Your new username")
      .setMinLength(3)
      .setMaxLength(32)
      .setRequired(true)
  )
  .setDMPermission(false);

export async function execute(interaction) {
  if (!(await requireAllowedCommandChannel(interaction))) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!envBoolean("USERNAME_CHANGE_ENABLED", true)) {
    return interaction.editReply("Username changes are currently disabled.");
  }

  const requireRole = envBoolean("USERNAME_CHANGE_REQUIRE_ROLE", false);
  if (
    requireRole &&
    !memberHasConfiguredRole(interaction, "USERNAME_CHANGE_ROLE_IDS", { allowWhenEmpty: false })
  ) {
    return interaction.editReply("You do not have a role that can change usernames.");
  }

  const username = interaction.options.getString("username", true).trim();
  const maxLength = envInteger("ACCOUNT_USERNAME_MAX_LENGTH", 24, { min: 3, max: 32 });
  if (username.length < 3 || username.length > maxLength || !/^[a-zA-Z0-9 _.-]+$/.test(username)) {
    return interaction.editReply(
      `Username must be 3-${maxLength} characters and may only contain letters, numbers, spaces, underscores, periods, and hyphens.`
    );
  }

  try {
    const account = await Users.findOne({ discordId: interaction.user.id });
    if (!account) return interaction.editReply("You do not have a linked account.");

    const duplicate = await Users.exists({
      _id: { $ne: account._id },
      username_lower: username.toLowerCase(),
    });
    if (duplicate) return interaction.editReply("That username is already in use.");

    const oldUsername = account.username;
    account.username = username;
    account.username_lower = username.toLowerCase();
    await account.save();
    await Utils.RevokeAccountSessions(account.accountId);

    const embed = addBranding(
      new EmbedBuilder()
        .setTitle("Username changed")
        .setDescription(`Your username is now **${username}**. Active game sessions were signed out.`)
        .setTimestamp()
    );

    await sendAuditWebhook({
      title: "Username changed",
      user: interaction.user,
      fields: [
        { name: "Old username", value: oldUsername, inline: true },
        { name: "New username", value: username, inline: true },
        { name: "Discord ID", value: interaction.user.id, inline: true },
      ],
    });

    log.backend(`Username changed for ${account.accountId}: ${oldUsername} -> ${username}`);
    return interaction.editReply({ embeds: [embed] });
  } catch (error) {
    if (error?.code === 11000) return interaction.editReply("That username is already in use.");
    log.error(`Username command failed: ${error.message}`);
    return interaction.editReply("The username could not be changed because of an internal error.");
  }
}
