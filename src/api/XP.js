import "dotenv/config";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { v4 as uuidv4 } from "uuid";
import User from "../User/Mongodb/Schema/user.js";
import Profile from "../User/Mongodb/Schema/profiles.js";
import Utils from "../Utils/Utils.js";
import log from "../Utils/log.js";
import { envBoolean, envInteger, envString } from "../Config/env.js";
import {
  connectServiceMongo,
  createJsonServiceApp,
  installServiceNotFound,
  isDirectRun,
  listenService,
  privateApiMiddleware,
} from "./utils/service.js";

const PORT = envInteger("XP_API_PORT", 78, { min: 1, max: 65535 });
const MAIN_SEASON = envInteger("MAIN_SEASON", 10, { min: 0, max: 35 });
const MAX_LEVEL = envInteger("XP_MAX_LEVEL", MAIN_SEASON < 11 ? 100 : 1000, {
  min: 1,
  max: 10000,
});
const MAX_XP_PER_REQUEST = envInteger("XP_MAX_PER_REQUEST", 1000000, {
  min: 1,
  max: 100000000,
});
const ENABLE_LEGACY_GET = envBoolean("REWARDS_ENABLE_LEGACY_GET", true);
const GRANT_PAID_REWARDS = envBoolean("XP_GRANT_PAID_BATTLEPASS_REWARDS", true);
const app = createJsonServiceApp("xp-api");
const authenticate = privateApiMiddleware({ serviceName: "xp-api" });

const seasonFolder = fileURLToPath(
  new URL(`../local/Battlepass/Data/Season${MAIN_SEASON}/`, import.meta.url)
);

function readJson(filename, fallback = []) {
  const filePath = `${seasonFolder}${filename}`;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(parsed) ? parsed : fallback;
  } catch (error) {
    log.warn(`Unable to load ${filePath}: ${error.message}`);
    return fallback;
  }
}

const levelData = readJson("SeasonXP.json");
const battleStarsData = MAIN_SEASON <= 10 ? readJson("SeasonBP.json") : [];
const freeBattlePassData = readJson("SeasonFreeBattlepass.json");
const paidBattlePassData = readJson("SeasonPaidBattlepass.json");
const levelByNumber = new Map(levelData.map((entry) => [Number(entry.Level), entry]));
const starsByLevel = new Map(
  battleStarsData.map((entry) => [Number(entry.Level), Number(entry.BattleStars || 0)])
);
const freeRewardsByTier = new Map(
  freeBattlePassData.map((entry) => [Number(entry.Level), entry.Rewards || []])
);
const paidRewardsByTier = new Map(
  paidBattlePassData.map((entry) => [Number(entry.Level), entry.Rewards || []])
);

function calculateProgress(attributes, amount) {
  const updated = { ...attributes };
  let xp = Number(updated.xp || 0) + amount;
  let level = Math.max(1, Number(updated.level || 1));
  let battleStars = Math.max(0, Number(updated.book_xp || 0));
  let tier = Math.max(0, Number(updated.book_level || 0));
  const reachedTiers = [];

  while (level < MAX_LEVEL) {
    const requiredXp = Number(levelByNumber.get(level)?.XpToNextLevel || 0);
    if (!Number.isFinite(requiredXp) || requiredXp <= 0 || xp < requiredXp) break;

    xp -= requiredXp;
    level += 1;

    if (MAIN_SEASON <= 10) {
      battleStars += Number(starsByLevel.get(level) || 0);
      while (battleStars >= 10 && tier < 100) {
        battleStars -= 10;
        tier += 1;
        reachedTiers.push(tier);
      }
    } else if (level > tier) {
      for (let rewardTier = tier + 1; rewardTier <= level; rewardTier += 1) {
        reachedTiers.push(rewardTier);
      }
      tier = level;
      battleStars = 0;
    }
  }

  updated.xp = xp;
  updated.level = level;
  updated.book_xp = battleStars;
  updated.book_level = tier;
  return { attributes: updated, reachedTiers, level, xp, tier, battleStars };
}

function buildTierRewards(profile, tiers) {
  const set = {};
  const owned = new Set(Object.keys(profile.profiles.athena.items || {}));
  let vbucks = 0;
  let grantedItems = 0;
  let giftCount = 0;

  for (const tier of tiers) {
    const rewards = [
      ...(freeRewardsByTier.get(tier) || []),
      ...(GRANT_PAID_REWARDS ? paidRewardsByTier.get(tier) || [] : []),
    ];
    const lootList = [];

    for (const reward of rewards) {
      const templateId = String(reward?.templateId || "").trim();
      const quantity = Math.max(1, Number.parseInt(reward?.quantity || 1, 10) || 1);
      if (!templateId || templateId.includes(".") || templateId.startsWith("$")) continue;

      if (templateId === "Currency:MtxPurchased") {
        vbucks += quantity;
        lootList.push({
          itemType: templateId,
          itemGuid: `${templateId}_${uuidv4()}`,
          quantity,
        });
        continue;
      }

      if (owned.has(templateId)) continue;
      owned.add(templateId);
      set[`profiles.athena.items.${templateId}`] = {
        templateId,
        attributes: { item_seen: false, variants: [], favorite: false },
        quantity,
      };
      grantedItems += 1;
      lootList.push({
        itemType: templateId,
        itemGuid: `${templateId}_${uuidv4()}`,
        quantity,
      });
    }

    if (lootList.length > 0) {
      const giftId = uuidv4();
      set[`profiles.common_core.items.${giftId}`] = {
        templateId: "GiftBox:GB_BattlePass",
        attributes: {
          fromAccountId: envString("REWARD_GIFT_SENDER", "[Epic Games]"),
          params: {
            DefaultHeaderText: "BATTLE PASS TIER UP!",
            userMessage: `You've reached Battle Pass tier ${tier}!`,
          },
          lootList,
          giftedOn: new Date().toISOString(),
        },
        quantity: 1,
      };
      giftCount += 1;
    }
  }

  return { set, vbucks, grantedItems, giftCount };
}

async function addXp(req, res) {
  const username = String(req.params.username || "").trim();
  const amount = Number.parseInt(String(req.body?.amount ?? req.params.amount ?? ""), 10);

  if (!username || username.length > 32) {
    return res.status(400).json({ error: "invalid_username" });
  }
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_XP_PER_REQUEST) {
    return res.status(400).json({
      error: "invalid_amount",
      message: `XP amount must be between 1 and ${MAX_XP_PER_REQUEST}.`,
    });
  }
  if (levelData.length === 0) {
    return res.status(503).json({ error: "season_xp_data_unavailable" });
  }

  try {
    const user = await User.findOne({ username_lower: username.toLowerCase() }).lean();
    if (!user) return res.status(404).json({ error: "user_not_found" });

    const profile = await Profile.findOne({ accountId: user.accountId }).lean();
    if (!profile?.profiles?.athena || !profile?.profiles?.common_core) {
      return res.status(404).json({ error: "profile_not_found" });
    }

    const progress = calculateProgress(profile.profiles.athena.stats?.attributes || {}, amount);
    const rewards = buildTierRewards(profile, progress.reachedTiers);
    const set = {
      "profiles.athena.stats.attributes": progress.attributes,
      ...rewards.set,
    };
    const increment = {
      "profiles.athena.rvn": 1,
      "profiles.athena.commandRevision": 1,
    };
    const query = {
      accountId: user.accountId,
      "profiles.athena.rvn": Number(profile.profiles.athena.rvn || 0),
    };

    if (rewards.giftCount > 0 || rewards.vbucks > 0) {
      query["profiles.common_core.rvn"] = Number(profile.profiles.common_core.rvn || 0);
      increment["profiles.common_core.rvn"] = 1;
      increment["profiles.common_core.commandRevision"] = 1;
    }
    if (rewards.vbucks > 0) {
      increment["profiles.common_core.items.Currency:MtxPurchased.quantity"] = rewards.vbucks;
    }

    const result = await Profile.updateOne(query, { $set: set, $inc: increment });
    if (Number(result.modifiedCount ?? result.nModified ?? 0) !== 1) {
      return res.status(409).json({ error: "profile_changed", message: "Retry the request." });
    }

    await Utils.SendEmptyGift(username, user.accountId);
    const nextLevelXp = Number(levelByNumber.get(progress.level)?.XpToNextLevel || 0);
    log.xp(`Added ${amount} XP to account ${user.accountId}; level ${progress.level}, tier ${progress.tier}`);

    return res.json({
      success: true,
      amount,
      level: progress.level,
      xp: progress.xp,
      xpToNextLevel: nextLevelXp || null,
      battlePassTier: progress.tier,
      battleStars: MAIN_SEASON <= 10 ? progress.battleStars : null,
      tiersReached: progress.reachedTiers,
      rewardsGranted: rewards.grantedItems,
      vbucksGranted: rewards.vbucks,
    });
  } catch (error) {
    log.error(`XP API request failed: ${error.message}`);
    return res.status(500).json({ error: "internal_server_error" });
  }
}

app.post("/api/v1/xp/:username", authenticate, addXp);
if (ENABLE_LEGACY_GET) {
  app.get("/api/v1/xp/:username/:amount", authenticate, addXp);
}
installServiceNotFound(app);

export { app, calculateProgress };
export async function startXpApi() {
  await connectServiceMongo("xp-api");
  return listenService(app, { port: PORT, serviceName: "XP API" });
}

if (isDirectRun(import.meta.url)) {
  startXpApi().catch((error) => {
    log.error(`XP API startup failed: ${error.message}`);
    process.exit(1);
  });
}
