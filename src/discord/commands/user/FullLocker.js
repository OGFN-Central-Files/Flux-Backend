import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { MessageFlags, SlashCommandBuilder } from "discord.js";
import log from "../../../Utils/log.js";
import { envBoolean, envInteger, envString } from "../../../Config/env.js";
import {
  memberHasConfiguredRole,
  requireAllowedCommandChannel,
  sendAuditWebhook,
} from "../../utils/discordUtils.js";
import {
  applyRewardAtomically,
  createGiftBox,
  getLinkedProfile,
} from "../../utils/rewardUtils.js";

const cosmeticsPath = fileURLToPath(
  new URL("../../../Profiles/FullLocker/allcosmetics.json", import.meta.url)
);
let cosmeticsCache = null;

function loadCosmetics() {
  if (cosmeticsCache) return cosmeticsCache;
  const parsed = JSON.parse(fs.readFileSync(cosmeticsPath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Full-locker cosmetics file must contain an object map");
  }
  cosmeticsCache = parsed;
  return cosmeticsCache;
}

export const data = new SlashCommandBuilder()
  .setName("claim-full-locker")
  .setDescription("Claim the configured full cosmetic locker")
  .setDMPermission(false);

export async function execute(interaction) {
  if (!(await requireAllowedCommandChannel(interaction))) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!envBoolean("FULL_LOCKER_REWARDS_ENABLED", true)) {
    return interaction.editReply("Full-locker rewards are currently disabled.");
  }
  if (!memberHasConfiguredRole(interaction, "FULL_LOCKER_ROLE_IDS")) {
    return interaction.editReply("You do not have a configured full-locker reward role.");
  }

  try {
    const linked = await getLinkedProfile(interaction.user.id);
    if (linked.error) return interaction.editReply(linked.error);

    const cosmetics = loadCosmetics();
    const cosmeticKeys = Object.keys(cosmetics);
    const existingItems = linked.profile.profiles.athena.items || {};
    const set = {};
    let itemsAdded = 0;

    for (const [key, item] of Object.entries(cosmetics)) {
      if (existingItems[key]) continue;
      set[`profiles.athena.items.${key}`] = item;
      itemsAdded += 1;
    }

    const chunkSize = envInteger("FULL_LOCKER_GIFT_CHUNK_SIZE", 100, { min: 25, max: 500 });
    const rewardMessage = envString("FULL_LOCKER_REWARD_MESSAGE", "Enjoy your full locker!");
    for (let index = 0; index < cosmeticKeys.length; index += chunkSize) {
      const chunk = cosmeticKeys.slice(index, index + chunkSize);
      const gift = createGiftBox({
        message: rewardMessage,
        lootList: chunk.map((key) => ({ itemType: key, itemGuid: key, quantity: 1 })),
        params: { DefaultHeaderText: "Full Locker" },
      });
      set[`profiles.common_core.items.${gift.id}`] = gift.item;
    }

    const claimed = await applyRewardAtomically({
      accountId: linked.user.accountId,
      marker: "FullLockerClaimed",
      set,
    });

    if (!claimed) return interaction.editReply("You already claimed the full-locker reward.");

    await sendAuditWebhook({
      title: "Full locker claimed",
      user: interaction.user,
      color: 0x57f287,
      fields: [
        { name: "Username", value: linked.user.username, inline: true },
        { name: "Items added", value: String(itemsAdded), inline: true },
        { name: "Locker size", value: String(cosmeticKeys.length), inline: true },
      ],
    });

    log.backend(`Full locker claimed by account ${linked.user.accountId}`);
    return interaction.editReply(
      `You successfully claimed the full locker. ${itemsAdded.toLocaleString()} missing items were added.`
    );
  } catch (error) {
    log.error(`Full-locker command failed: ${error.message}`);
    await sendAuditWebhook({
      title: "Full locker claim failed",
      user: interaction.user,
      color: 0xd9534f,
      fields: [{ name: "Reason", value: error.message }],
    });
    return interaction.editReply("The full locker could not be applied because of an internal error.");
  }
}
