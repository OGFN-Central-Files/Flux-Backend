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
  rewardVbucksAmount,
} from "../../utils/rewardUtils.js";

const COSMETIC_IDS = [
  "CID_017_Athena_Commando_M",
  "CID_028_Athena_Commando_F",
  "EID_Fresh",
  "EID_TakeTheL",
  "Pickaxe_Lockjaw",
  "Pickaxe_ID_015_HolidayCandyCane",
  "CID_030_Athena_Commando_M_Halloween",
  "CID_029_Athena_Commando_F_Halloween",
  "Glider_Warthog",
];

function itemFor(cosmeticId) {
  const key = cosmeticTemplateKey(cosmeticId);
  const variants = [];

  if (cosmeticId === "CID_030_Athena_Commando_M_Halloween") {
    variants.push(
      { channel: "ClothingColor", active: "Mat0", owned: ["Mat0", "Mat1", "Mat2", "Mat3", "Mat4"] },
      { channel: "Parts", active: "Stage1", owned: ["Stage1", "Stage2"] }
    );
  } else if (cosmeticId === "CID_029_Athena_Commando_F_Halloween") {
    variants.push({ channel: "Material", active: "Mat1", owned: ["Mat1", "Mat2", "Mat3"] });
  }

  return {
    key,
    item: {
      templateId: key,
      attributes: { item_seen: false, variants, favorite: false },
      quantity: 1,
    },
  };
}

function lootFor(cosmeticId) {
  const itemType = cosmeticTemplateKey(cosmeticId);
  const entry = { itemType, itemGuid: itemType, quantity: 1 };

  if (cosmeticId === "CID_030_Athena_Commando_M_Halloween") {
    entry.variantUpdates = [
      { channel: "ClothingColor", variant: "Mat0" },
      { channel: "Parts", variant: "Stage1" },
    ];
  } else if (cosmeticId === "CID_029_Athena_Commando_F_Halloween") {
    entry.variantUpdates = [{ channel: "Material", variant: "Mat1" }];
  }

  return entry;
}

export const data = new SlashCommandBuilder()
  .setName("claim-legacy-bundle")
  .setDescription("Claim the configured legacy reward bundle")
  .setDMPermission(false);

export async function execute(interaction) {
  if (!(await requireAllowedCommandChannel(interaction))) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!envBoolean("LEGACY_REWARDS_ENABLED", true)) {
    return interaction.editReply("Legacy rewards are currently disabled.");
  }
  if (!memberHasConfiguredRole(interaction, "LEGACY_REWARD_ROLE_IDS")) {
    return interaction.editReply("You do not have a configured legacy reward role.");
  }

  try {
    const linked = await getLinkedProfile(interaction.user.id);
    if (linked.error) return interaction.editReply(linked.error);

    const existingItems = linked.profile.profiles.athena.items || {};
    const set = {};
    for (const cosmeticId of COSMETIC_IDS) {
      const { key, item } = itemFor(cosmeticId);
      if (!existingItems[key]) set[`profiles.athena.items.${key}`] = item;
    }

    const vbucks = rewardVbucksAmount();
    const lootList = COSMETIC_IDS.map(lootFor);
    if (vbucks > 0) {
      lootList.push({
        itemType: "Currency:MtxPurchased",
        itemGuid: "Currency:MtxPurchased",
        quantity: vbucks,
      });
    }

    const gift = createGiftBox({
      message: envString("LEGACY_REWARD_MESSAGE", "Enjoy the legacy reward bundle!"),
      lootList,
    });
    set[`profiles.common_core.items.${gift.id}`] = gift.item;

    const claimed = await applyRewardAtomically({
      accountId: linked.user.accountId,
      marker: "LegacyBundleClaimed",
      set,
      increment: vbucks > 0
        ? { "profiles.common_core.items.Currency:MtxPurchased.quantity": vbucks }
        : {},
    });

    if (!claimed) return interaction.editReply("You already claimed the legacy reward bundle.");

    await sendAuditWebhook({
      title: "Legacy bundle claimed",
      user: interaction.user,
      color: 0x57f287,
      fields: [
        { name: "Username", value: linked.user.username, inline: true },
        { name: "Cosmetics", value: String(COSMETIC_IDS.length), inline: true },
        { name: "V-Bucks", value: String(vbucks), inline: true },
      ],
    });

    log.backend(`Legacy rewards claimed by account ${linked.user.accountId}`);
    return interaction.editReply("You successfully claimed the legacy reward bundle.");
  } catch (error) {
    log.error(`Legacy reward command failed: ${error.message}`);
    await sendAuditWebhook({
      title: "Legacy reward claim failed",
      user: interaction.user,
      color: 0xd9534f,
      fields: [{ name: "Reason", value: error.message }],
    });
    return interaction.editReply("The legacy reward bundle could not be applied because of an internal error.");
  }
}
