import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from "discord.js";
import Users from "../../../User/Mongodb/Schema/user.js";
import Utils from "../../../Utils/Utils.js";
import log from "../../../Utils/log.js";
import { envBoolean } from "../../../Config/env.js";
import { generateAccountCredentials } from "../../utils/accountCredentials.js";
import {
  addBranding,
  allowedChannelMessage,
  isAllowedCommandChannel,
  safeDm,
  sendAuditWebhook,
} from "../../utils/discordUtils.js";

export const data = new SlashCommandBuilder()
  .setName("create")
  .setDescription("Create your game and launcher account")
  .setDMPermission(false);

function credentialsEmbed(credentials) {
  const embed = new EmbedBuilder()
    .setTitle("Your account is ready")
    .setDescription(
      "These credentials work in the launcher and game. Save them somewhere private. The password is only shown in this DM."
    )
    .addFields(
      { name: "Username", value: `\`${credentials.username}\``, inline: false },
      { name: "Email", value: `\`${credentials.email}\``, inline: false },
      { name: "Password", value: `||\`${credentials.password}\`||`, inline: false }
    )
    .setTimestamp();
  return addBranding(embed);
}

export async function execute(interaction) {
  if (!envBoolean("ACCOUNT_CREATION_ENABLED", true)) {
    return interaction.reply({ content: "Account creation is currently disabled.", flags: MessageFlags.Ephemeral });
  }

  if (!isAllowedCommandChannel(interaction)) {
    return interaction.reply({ content: allowedChannelMessage(), flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const discordId = interaction.user.id;

  try {
    const existing = await Users.findOne({ discordId }).lean();
    if (existing) {
      return interaction.editReply({
        content: `You already have an account named **${existing.username}**. A new password cannot be displayed because passwords are stored as hashes.`,
      });
    }

    const credentials = await generateAccountCredentials(interaction.user);
    const result = await Utils.CreateUser(
      discordId,
      credentials.username,
      credentials.email,
      credentials.password,
      false
    );

    if (result.status !== 201 || !result.user) {
      return interaction.editReply({ content: result.message });
    }

    const dmDelivered = await safeDm(interaction.user, {
      embeds: [credentialsEmbed(credentials)],
    });

    if (!dmDelivered && envBoolean("ACCOUNT_DM_REQUIRED", true)) {
      await Utils.DeleteAccountData(result.user.accountId);
      await sendAuditWebhook({
        title: "Account creation rolled back",
        description: "The generated credentials could not be delivered by DM.",
        user: interaction.user,
        color: 0xd9534f,
        fields: [
          { name: "Discord ID", value: discordId, inline: true },
          { name: "Generated username", value: credentials.username, inline: true },
        ],
      });
      return interaction.editReply({
        content:
          "I could not DM you, so the new account was safely removed. Enable direct messages from server members and run `/create` again.",
      });
    }

    if (!dmDelivered) {
      await interaction.editReply({
        content: "Your account was created, but the DM failed. Here are the credentials in this private response:",
        embeds: [credentialsEmbed(credentials)],
      });
    } else {
      await interaction.editReply({
        content: "Account created. I sent your username, email, and password to your DMs.",
      });
    }

    if (envBoolean("CREATE_PUBLIC_ANNOUNCEMENT", false) && interaction.channel) {
      const welcome = addBranding(
        new EmbedBuilder()
          .setTitle("New registration")
          .setDescription(`Welcome **${credentials.username}**!`)
          .setThumbnail(interaction.user.displayAvatarURL({ extension: "png", size: 128 }))
          .setTimestamp()
      );
      await interaction.channel.send({ embeds: [welcome] }).catch(() => {});
    }

    await sendAuditWebhook({
      title: "New account created",
      description: "Credentials were generated automatically and the password was not logged.",
      user: interaction.user,
      fields: [
        { name: "Username", value: credentials.username, inline: true },
        { name: "Discord ID", value: discordId, inline: true },
        { name: "DM delivered", value: dmDelivered ? "Yes" : "No", inline: true },
      ],
    });

    log.backend(`Account created for Discord ${discordId} as ${credentials.username}`);
  } catch (error) {
    log.error(`Account creation command failed for ${discordId}: ${error.message}`);
    if (interaction.replied || interaction.deferred) {
      return interaction.editReply({
        content: "Account creation failed. No password was stored or logged. Please try again later.",
      });
    }
    return interaction.reply({
      content: "Account creation failed. Please try again later.",
      flags: MessageFlags.Ephemeral,
    });
  }
}
