import {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { v4 } from "uuid";
import Profiles from "../../../User/Mongodb/Schema/profiles.js";
import Users from "../../../User/Mongodb/Schema/user.js";
import Utils from "../../../Utils/Utils.js";
import log from "../../../Utils/log.js";
import { envInteger } from "../../../Config/env.js";
import {
  addBranding,
  requireAllowedCommandChannel,
  requireModerator,
  sendAuditWebhook,
} from "../../utils/discordUtils.js";

export const data = new SlashCommandBuilder()
  .setName("grant-vbucks")
  .setDescription("Add V-Bucks to a linked backend account")
  .addUserOption((option) =>
    option
      .setName("user")
      .setDescription("Discord user whose backend account should receive V-Bucks")
      .setRequired(true)
  )
  .addIntegerOption((option) =>
    option
      .setName("amount")
      .setDescription("Amount of V-Bucks to grant")
      .setMinValue(1)
      .setMaxValue(1000000)
      .setRequired(true)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

export async function execute(interaction) {
  if (!(await requireModerator(interaction))) return;
  if (!(await requireAllowedCommandChannel(interaction))) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const discordUser = interaction.options.getUser("user", true);
  const amount = interaction.options.getInteger("amount", true);
  const maxAmount = envInteger("DISCORD_GRANT_VBUCKS_MAX", 1000000, { min: 1, max: 1000000 });

  if (amount > maxAmount) {
    return interaction.editReply(`The maximum grant is ${maxAmount.toLocaleString()} V-Bucks.`);
  }

  try {
    const account = await Users.findOne({ discordId: discordUser.id }).lean();
    if (!account) return interaction.editReply("That Discord user does not have a linked backend account.");

    const giftId = v4();
    const result = await Profiles.updateOne(
      { accountId: account.accountId },
      {
        $inc: {
          "profiles.common_core.items.Currency:MtxPurchased.quantity": amount,
          "profiles.profile0.items.Currency:MtxPurchased.quantity": amount,
          "profiles.common_core.rvn": 1,
          "profiles.common_core.commandRevision": 1,
          "profiles.profile0.rvn": 1,
          "profiles.profile0.commandRevision": 1,
        },
        $set: {
          "profiles.common_core.updated": new Date().toISOString(),
          [`profiles.common_core.items.${giftId}`]: {
            templateId: "GiftBox:GB_MakeGood",
            attributes: {
              fromAccountId: "[Administrator]",
              lootList: [
                {
                  itemType: "Currency:MtxPurchased",
                  itemGuid: "Currency:MtxPurchased",
                  quantity: amount,
                },
              ],
              params: {
                userMessage: `You received ${amount.toLocaleString()} V-Bucks.`,
              },
              giftedOn: new Date().toISOString(),
            },
            quantity: 1,
          },
        },
      }
    );

    if (Number(result.matchedCount ?? result.n ?? 0) !== 1) {
      return interaction.editReply("That user has an account, but no profile document was found.");
    }

    await Utils.SendEmptyGift(account.username, account.accountId).catch(() => {});

    await sendAuditWebhook({
      title: "V-Bucks granted",
      user: discordUser,
      color: 0x57f287,
      fields: [
        { name: "Username", value: account.username, inline: true },
        { name: "Amount", value: amount.toLocaleString(), inline: true },
        { name: "Moderator", value: `${interaction.user.tag} (${interaction.user.id})` },
      ],
    });

    log.backend(`Granted ${amount} V-Bucks to account ${account.accountId} by ${interaction.user.id}`);

    const embed = addBranding(
      new EmbedBuilder()
        .setTitle("V-Bucks granted")
        .setDescription(`Added **${amount.toLocaleString()}** V-Bucks to **${account.username}**.`)
        .setTimestamp()
    );

    return interaction.editReply({ embeds: [embed] });
  } catch (error) {
    log.error(`Grant V-Bucks command failed: ${error.message}`);
    return interaction.editReply("V-Bucks could not be granted because of an internal error.");
  }
}
