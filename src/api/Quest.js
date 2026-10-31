import express from "express";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import User from "../User/Mongodb/Schema/user.js";
import Profile from "../User/Mongodb/Schema/profiles.js";
import log from "../Utils/log.js";
import {
  envBoolean,
  envInteger,
  envString,
  requireEnvironment,
} from "../Config/env.js";

const PORT = envInteger("QUEST_API_PORT", 88, { min: 1, max: 65535 });
const API_KEY = envString("QUEST_API_KEY", envString("REWARDS_API_KEY", envString("API_KEY", "")));
const REQUIRE_API_KEY = envBoolean("QUEST_API_REQUIRE_KEY", true);
const ENABLE_LEGACY_GET = envBoolean("QUEST_ENABLE_LEGACY_GET", true);
const MAX_PROGRESS = envInteger("QUEST_MAX_PROGRESS_PER_REQUEST", 1000, { min: 1, max: 100000 });
const DEFAULT_PROGRESS_ATTRIBUTE = envString(
  "QUEST_PROGRESS_ATTRIBUTE",
  "completion_athena_daily_kill_players_assault_rifles"
);

if (REQUIRE_API_KEY) {
  requireEnvironment(["MONGO_URI"]);
  if (!API_KEY) {
    throw new Error(
      "Quest API authentication is enabled, but QUEST_API_KEY, REWARDS_API_KEY, and API_KEY are empty."
    );
  }
} else {
  requireEnvironment(["MONGO_URI"]);
}

const connectToMongoDB = async () => {
  if (mongoose.connection.readyState === 1) return;

  mongoose.set("strictQuery", true);
  await mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: envInteger("MONGO_TIMEOUT_MS", 10000, {
      min: 1000,
      max: 120000,
    }),
  });
  log.database("Connected to MongoDB for Quest API");
};

export const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: envString("HTTP_BODY_LIMIT", "1mb") }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "quest-api" });
});

const authenticate = (req, res, next) => {
  if (!REQUIRE_API_KEY) return next();

  const providedKey = req.get("x-api-key");
  if (!providedKey || providedKey !== API_KEY) {
    log.api(`Rejected Quest API request from ${req.ip}`);
    return res.status(401).json({ error: "Invalid API key" });
  }

  return next();
};

const updateQuestProgress = async (req, res) => {
  const username = String(req.params.username ?? "").trim();
  const questId = String(req.params.questId ?? "").trim();
  const rawCount = req.body?.count ?? req.params.count;
  const questCount = Number.parseInt(String(rawCount), 10);

  if (!username || username.length > 64) {
    return res.status(400).json({ error: "Invalid username" });
  }
  if (!questId || questId.length > 160 || !/^[A-Za-z0-9_.:-]+$/.test(questId)) {
    return res.status(400).json({ error: "Invalid quest ID" });
  }
  if (!Number.isSafeInteger(questCount) || questCount <= 0 || questCount > MAX_PROGRESS) {
    return res.status(400).json({
      error: `Quest progress must be between 1 and ${MAX_PROGRESS}`,
    });
  }

  try {
    const user = await User.findOne({ username_lower: username.toLowerCase() }).lean();
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const profile = await Profile.findOne({ accountId: user.accountId });
    const athenaItems = profile?.profiles?.athena?.items;
    if (!athenaItems || typeof athenaItems !== "object") {
      return res.status(404).json({ error: "Athena profile not found" });
    }

    const expectedTemplateId = questId.toLowerCase().startsWith("quest:")
      ? questId
      : `Quest:${questId}`;

    const match = Object.entries(athenaItems).find(
      ([, item]) => String(item?.templateId ?? "").toLowerCase() === expectedTemplateId.toLowerCase()
    );

    if (!match) {
      return res.status(404).json({ error: "Quest not found" });
    }

    const [questKey, questItem] = match;
    const currentValue = Number(questItem?.attributes?.[DEFAULT_PROGRESS_ATTRIBUTE] ?? 0);
    const nextValue = (Number.isFinite(currentValue) ? currentValue : 0) + questCount;
    const now = new Date().toISOString();

    const result = await Profile.updateOne(
      { accountId: user.accountId },
      {
        $set: {
          [`profiles.athena.items.${questKey}.attributes.${DEFAULT_PROGRESS_ATTRIBUTE}`]: nextValue,
          [`profiles.athena.items.${questKey}.attributes.last_state_change_time`]: now,
        },
        $inc: {
          "profiles.athena.rvn": 1,
          "profiles.athena.commandRevision": 1,
        },
      }
    );

    if (!result.acknowledged || result.matchedCount !== 1) {
      return res.status(409).json({ error: "Quest profile changed before it could be updated" });
    }

    log.api(`Updated quest ${questId} for account ${user.accountId} by ${questCount}`);
    return res.json({
      success: true,
      questId,
      added: questCount,
      progress: nextValue,
    });
  } catch (error) {
    log.error(`Quest API update failed: ${error.message}`);
    return res.status(500).json({ error: "Unable to update quest progress" });
  }
};

app.post("/api/v1/quest/:username/:questId/progress", authenticate, updateQuestProgress);

if (ENABLE_LEGACY_GET) {
  app.get("/api/v1/quest/:username/:questId/:count", authenticate, updateQuestProgress);
}

app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

export const startQuestApi = async () => {
  await connectToMongoDB();
  return app.listen(PORT, () => {
    log.api(`Quest API server running on port ${PORT}`);
  });
};

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  startQuestApi().catch((error) => {
    log.error(`Quest API startup failed: ${error.message}`);
    process.exit(1);
  });
}
