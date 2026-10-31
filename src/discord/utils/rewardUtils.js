import { v4 as uuidv4 } from "uuid";
import User from "../../User/Mongodb/Schema/user.js";
import Profile from "../../User/Mongodb/Schema/profiles.js";
import { envInteger, envString } from "../../Config/env.js";

export function cosmeticTemplateKey(cosmeticId) {
  const id = String(cosmeticId || "");
  if (id.startsWith("CID_")) return `AthenaCharacter:${id}`;
  if (id.startsWith("EID_")) return `AthenaDance:${id}`;
  if (id.startsWith("Pickaxe_")) return `AthenaPickaxe:${id}`;
  if (id.startsWith("Glider_")) return `AthenaGlider:${id}`;
  if (id.startsWith("BID_") || id.startsWith("Backpack_")) return `AthenaBackpack:${id}`;
  return id;
}

export async function getLinkedProfile(discordId) {
  const user = await User.findOne({ discordId: String(discordId) }).lean();
  if (!user) return { error: "You do not have a linked account." };

  const profile = await Profile.findOne({ accountId: user.accountId }).lean();
  if (!profile?.profiles?.athena || !profile?.profiles?.common_core) {
    return { error: "Your backend profile is missing or incomplete." };
  }

  return { user, profile };
}

export function createGiftBox({
  templateId = "GiftBox:GB_MakeGood",
  message,
  lootList,
  params = {},
}) {
  return {
    id: uuidv4(),
    item: {
      templateId,
      attributes: {
        fromAccountId: envString("REWARD_GIFT_SENDER", "[Epic Games]"),
        params: {
          userMessage: message,
          ...params,
        },
        lootList,
        giftedOn: new Date().toISOString(),
      },
      quantity: 1,
    },
  };
}

export async function applyRewardAtomically({
  accountId,
  marker,
  set = {},
  increment = {},
  incrementAthena = true,
  incrementCommonCore = true,
}) {
  const markerPath = `profiles.common_core.items.stats.attributes.${marker}`;
  const increments = { ...increment };

  if (incrementAthena) {
    increments["profiles.athena.rvn"] = 1;
    increments["profiles.athena.commandRevision"] = 1;
  }
  if (incrementCommonCore) {
    increments["profiles.common_core.rvn"] = 1;
    increments["profiles.common_core.commandRevision"] = 1;
  }

  const result = await Profile.updateOne(
    {
      accountId,
      [markerPath]: { $ne: true },
    },
    {
      $set: {
        ...set,
        [markerPath]: true,
      },
      ...(Object.keys(increments).length > 0 ? { $inc: increments } : {}),
    }
  );

  return Number(result.modifiedCount ?? result.nModified ?? 0) === 1;
}

export function rewardVbucksAmount() {
  return envInteger("LEGACY_REWARD_VBUCKS", 2000, { min: 0, max: 1000000 });
}
