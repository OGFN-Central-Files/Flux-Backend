import express from "express";
import crypto from "node:crypto";
import User from "../User/Mongodb/Schema/user.js";
import log from "../Utils/log.js";
import { envBoolean, envInteger } from "../Config/env.js";

const router = express.Router();

const leaderboardTypes = {
  arena: {
    score: { $ifNull: ["$profile.profiles.athena.stats.attributes.arena_hype", 0] },
    label: "Hype",
  },
  wins: {
    score: { $ifNull: ["$profile.profiles.athena.stats.attributes.lifetime_wins", 0] },
    label: "Wins",
  },
  kills: {
    score: { $ifNull: ["$profile.profiles.athena.stats.attributes.lifetime_kills", 0] },
    label: "Eliminations",
  },
  tournament: {
    score: { $ifNull: ["$tournamentDetails.points", 0] },
    label: "Tournament Points",
  },
};

const defaultLimit = envInteger("LEADERBOARD_DEFAULT_LIMIT", 25, { min: 1, max: 100 });
const responseMaxAge = envInteger("LEADERBOARD_CACHE_SECONDS", 15, { min: 0, max: 300 });
const defaultIncludeZero = envBoolean("LEADERBOARD_INCLUDE_ZERO_SCORES", true);

function positiveInteger(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseBoolean(value, fallback) {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

async function getLeaderboard(req, res) {
  const type = String(req.params.type || req.query.type || "arena").toLowerCase();
  const config = leaderboardTypes[type];

  if (!config) {
    return res.status(400).json({
      error: "invalid_leaderboard_type",
      message: `Type must be one of: ${Object.keys(leaderboardTypes).join(", ")}.`,
    });
  }

  const page = positiveInteger(req.query.page, 1, 100000);
  const limit = positiveInteger(req.query.limit, defaultLimit, 100);
  const skip = (page - 1) * limit;
  const search = String(req.query.search || "").trim().slice(0, 64);
  const includeZero = parseBoolean(req.query.includeZero, defaultIncludeZero);

  const accountMatch = { banned: { $ne: true } };
  if (search) {
    const regex = new RegExp(escapeRegex(search), "i");
    accountMatch.$or = [{ username: regex }, { username_lower: regex }, { accountId: regex }];
  }

  try {
    const scoreFilter = includeZero ? [] : [{ $match: { score: { $gt: 0 } } }];
    const [result] = await User.aggregate([
      { $match: accountMatch },
      {
        $lookup: {
          from: "profiles",
          localField: "accountId",
          foreignField: "accountId",
          as: "profile",
        },
      },
      { $unwind: { path: "$profile", preserveNullAndEmptyArrays: true } },
      {
        $addFields: {
          score: config.score,
          arenaHype: {
            $ifNull: ["$profile.profiles.athena.stats.attributes.arena_hype", 0],
          },
          lifetimeWins: {
            $ifNull: ["$profile.profiles.athena.stats.attributes.lifetime_wins", 0],
          },
          lifetimeKills: {
            $ifNull: ["$profile.profiles.athena.stats.attributes.lifetime_kills", 0],
          },
        },
      },
      ...scoreFilter,
      { $sort: { score: -1, username_lower: 1 } },
      {
        $facet: {
          summary: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                topScore: { $max: "$score" },
                averageScore: { $avg: "$score" },
                totalScore: { $sum: "$score" },
              },
            },
            { $project: { _id: 0, total: 1, topScore: 1, averageScore: 1, totalScore: 1 } },
          ],
          topThree: [
            { $limit: 3 },
            {
              $project: {
                _id: 0,
                accountId: 1,
                username: 1,
                score: 1,
                arenaHype: 1,
                lifetimeWins: 1,
                lifetimeKills: 1,
              },
            },
          ],
          entries: [
            { $skip: skip },
            { $limit: limit },
            {
              $project: {
                _id: 0,
                accountId: 1,
                username: 1,
                score: 1,
                arenaHype: 1,
                lifetimeWins: 1,
                lifetimeKills: 1,
                tournament: {
                  points: { $ifNull: ["$tournamentDetails.points", 0] },
                  kills: { $ifNull: ["$tournamentDetails.kills", 0] },
                  wins: { $ifNull: ["$tournamentDetails.wins", 0] },
                  matchesPlayed: { $ifNull: ["$tournamentDetails.matchesPlayed", 0] },
                },
              },
            },
          ],
        },
      },
    ]);

    const summary = result?.summary?.[0] || {
      total: 0,
      topScore: 0,
      averageScore: 0,
      totalScore: 0,
    };
    const total = summary.total || 0;
    const entries = (result?.entries || []).map((entry, index) => ({
      rank: skip + index + 1,
      ...entry,
    }));
    const topThree = (result?.topThree || []).map((entry, index) => ({
      rank: index + 1,
      ...entry,
    }));
    const updatedAt = new Date().toISOString();
    const etag = `W/"${crypto
      .createHash("sha1")
      .update(JSON.stringify({ type, page, limit, total, search, includeZero, updatedAt: updatedAt.slice(0, 16) }))
      .digest("hex")}"`;

    if (req.headers["if-none-match"] === etag) return res.status(304).end();

    res.set({
      "Cache-Control": `public, max-age=${responseMaxAge}, stale-while-revalidate=60`,
      ETag: etag,
      "X-Leaderboard-Type": type,
    });

    return res.status(200).json({
      schemaVersion: 2,
      type,
      label: config.label,
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      updatedAt,
      filtered: Boolean(search) || !includeZero,
      filters: {
        search: search || null,
        includeZero,
      },
      summary: {
        rankedPlayers: total,
        topScore: Number(summary.topScore || 0),
        averageScore: Number((summary.averageScore || 0).toFixed(2)),
        totalScore: Number(summary.totalScore || 0),
      },
      topThree,
      entries,
    });
  } catch (error) {
    log.error(`Launcher leaderboard API failed: ${error.message}`);
    return res.status(500).json({
      error: "leaderboard_unavailable",
      message: "Unable to load the leaderboard.",
    });
  }
}

router.get("/leaderboard", getLeaderboard);
router.get("/leaderboards", getLeaderboard);
router.get("/leaderboard/:type", getLeaderboard);

export default router;
