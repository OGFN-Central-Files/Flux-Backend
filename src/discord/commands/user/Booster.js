import { MessageFlags, SlashCommandBuilder } from "discord.js";
import log from "../../../Utils/log.js";
import { envBoolean, envString } from "../../../Config/env.js";
import {
  memberHasConfiguredRole,
  requireAllowedCommandChannel,
  sendAuditWebhook,
} from "../../utils/discordUtils.js";
import {
  applyRewardAtomically,
  cosmeticTemplateKey,
  createGiftBox,
  getLinkedProfile,
} from "../../utils/rewardUtils.js";

const ITEMS = {
  "AthenaCharacter:CID_089_Athena_Commando_M_RetroGrey": { templateId: "AthenaCharacter:CID_089_Athena_Commando_M_RetroGrey", attributes: { item_seen: false, variants: [], favorite: false }, quantity: 1 },
  "AthenaCharacter:CID_085_Athena_Commando_M_Twitch": { templateId: "AthenaCharacter:CID_085_Athena_Commando_M_Twitch", attributes: { item_seen: false, variants: [], favorite: false }, quantity: 1 },
  "AthenaCharacter:CID_114_Athena_Commando_F_TacticalWoodland": { templateId: "AthenaCharacter:CID_114_Athena_Commando_F_TacticalWoodland", attributes: { item_seen: false, variants: [], favorite: false }, quantity: 1 },
  "AthenaDance:EID_HipHop01": { templateId: "AthenaDance:EID_HipHop01", attributes: { item_seen: false, variants: [], favorite: false }, quantity: 1 },
  "AthenaPickaxe:Pickaxe_ID_044_TacticalUrbanHammer": { templateId: "AthenaPickaxe:Pickaxe_ID_044_TacticalUrbanHammer", attributes: { item_seen: false, variants: [], favorite: false }, quantity: 1 },
  "AthenaGlider:Glider_ID_018_Twitch": { templateId: "AthenaGlider:Glider_ID_018_Twitch", attributes: { item_seen: false, variants: [], favorite: false }, quantity: 1 },
  "AthenaBackpack:BID_049_TacticalWoodland": { templateId: "AthenaBackpack:BID_049_TacticalWoodland", attributes: { item_seen: false, variants: [], favorite: false }, quantity: 1 },
};

export const data = new SlashCommandBuilder()
  .setName("claim-booster-rewards")
  .setDescription("Claim the configured booster reward pack")
  .setDMPermission(false);

export async function execute(interaction) {
  if (!(await requireAllowedCommandChannel(interaction))) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!envBoolean("BOOSTER_REWARDS_ENABLED", true)) {
    return interaction.editReply("Booster rewards are currently disabled.");
  }
  if (!memberHasConfiguredRole(interaction, "BOOSTER_ROLE_IDS")) {
    return interaction.editReply("You do not have a configured booster reward role.");
  }

  try {
    const linked = await getLinkedProfile(interaction.user.id);
    if (linked.error) return interaction.editReply(linked.error);

    const currentItems = linked.profile.profiles.athena.items || {};
    const set = {};
    const lootList = [];

    for (const [key, item] of Object.entries(ITEMS)) {
      if (!currentItems[key]) set[`profiles.athena.items.${key}`] = structuredClone(item);
      lootList.push({ itemType: key, itemGuid: key, quantity: 1 });
    }

    const gift = createGiftBox({
      templateId: "GiftBox:GB_Twitch",
      message: envString("BOOSTER_REWARD_MESSAGE", "Enjoy your booster rewards!"),
      lootList,
      params: {
        DefaultHeaderText: "Booster Rewards",
        DefaultBodyText: "Thanks for supporting the server!",
      },
    });
    set[`profiles.common_core.items.${gift.id}`] = gift.item;

    const claimed = await applyRewardAtomically({
      accountId: linked.user.accountId,
      marker: "BoosterRewards",
      set,
    });

    if (!claimed) return interaction.editReply("You already claimed the booster rewards.");

    await sendAuditWebhook({
      title: "Booster rewards claimed",
      user: interaction.user,
      color: 0x57f287,
      fields: [
        { name: "Username", value: linked.user.username, inline: true },
        { name: "Items", value: String(Object.keys(ITEMS).length), inline: true },
      ],
    });

    log.backend(`Booster rewards claimed by account ${linked.user.accountId}`);
    return interaction.editReply("You successfully claimed the booster rewards.");
  } catch (error) {
    log.error(`Booster reward command failed: ${error.message}`);
    await sendAuditWebhook({
      title: "Booster reward claim failed",
      user: interaction.user,
      color: 0xd9534f,
      fields: [{ name: "Reason", value: error.message }],
    });
    return interaction.editReply("The booster rewards could not be applied because of an internal error.");
  }
}
