import {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import Profiles from "../../../User/Mongodb/Schema/profiles.js";
import Users from "../../../User/Mongodb/Schema/user.js";
import {
  addBranding,
  requireAllowedCommandChannel,
  requireModerator,
} from "../../utils/discordUtils.js";

export const data = new SlashCommandBuilder()
  .setName("account-info")
  .setDescription("Show basic info for a linked backend account")
  .addUserOption((option) =>
    option
      .setName("user")
      .setDescription("Discord user to inspect")
      .setRequired(true)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

export async function execute(interaction) {
  if (!(await requireModerator(interaction))) return;
  if (!(await requireAllowedCommandChannel(interaction))) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const discordUser = interaction.options.getUser("user", true);
  const account = await Users.findOne({ discordId: discordUser.id }).lean();
  if (!account) return interaction.editReply("That Discord user does not have a linked backend account.");

  const profile = await Profiles.findOne({ accountId: account.accountId }).lean();
  const commonCore = profile?.profiles?.common_core;
  const athena = profile?.profiles?.athena;
  const vbucks = Number(commonCore?.items?.["Currency:MtxPurchased"]?.quantity || 0);
  const hype = Number(athena?.stats?.attributes?.arena_hype || 0);

  const embed = addBranding(
    new EmbedBuilder()
      .setTitle("Account info")
      .addFields(
        { name: "Username", value: account.username, inline: true },
        { name: "Account ID", value: account.accountId, inline: true },
        { name: "Banned", value: account.banned ? "Yes" : "No", inline: true },
        { name: "V-Bucks", value: vbucks.toLocaleString(), inline: true },
        { name: "Arena hype", value: hype.toLocaleString(), inline: true },
        { name: "Profile", value: profile ? "Found" : "Missing", inline: true }
      )
      .setTimestamp()
  );

  return interaction.editReply({ embeds: [embed] });
}
