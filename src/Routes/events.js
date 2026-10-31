import express from "express";
import fs from "fs";
import mongoose from "mongoose";
import Utils from "../Utils/Utils.js";
import log from "../Utils/log.js";
import path from "path";
import { dirname } from "dirname-filename-esm";
import { verifyToken } from "../User/tokenManager/tokenVerify.js";
import { v4 } from "uuid";
import dotenv from "dotenv";
dotenv.config();

const __dirname = dirname(import.meta);
const app = express.Router();

const userSchema = new mongoose.Schema({
  username: String,
  accountId: String,
  tournamentDetails: {
    kills: { type: Number, default: 0 },
    placement: { type: Number, default: 0 },
    points: { type: Number, default: 0 },
    wins: { type: Number, default: 0 },
    matchesPlayed: { type: Number, default: 0 },
    matches: { type: Array, default: [] },
    played: { type: Boolean, default: false },
  },
});

const profileSchema = new mongoose.Schema({
  accountId: String,
  profiles: {
    athena: {
      stats: {
        attributes: {
          arena_hype: { type: Number, default: 0 },
        },
      },
    },
  },
});

const User = mongoose.models.users || mongoose.model("users", userSchema);
const Profile = mongoose.models.profiles || mongoose.model("profiles", profileSchema);
const eventsPath = path.join(__dirname, "../local/events/Events.json");

async function GetPlayerHype(accountId) {
  try {
    const profile = await Profile.findOne({ accountId }).lean();
    return profile?.profiles?.athena?.stats?.attributes?.arena_hype || 0;
  } catch (error) {
    log.error(`Error fetching player hype for ${accountId}: ${error.message}`);
    return 0;
  }
}

function getDivisionFromHype(hype, seasonPrefix) {
  const thresholds = [16000, 12000, 6000, 4000, 2500, 1500, 1000, 500, 250, 0];
  const divIndex = thresholds.findIndex((t) => hype >= t);
  const divNumber = divIndex === -1 ? 1 : 10 - divIndex;
  return {
    number: divNumber,
    tokens: Array.from({ length: divNumber }, (_, i) => `LG_ARENA_${seasonPrefix}_Division${i + 1}`),
  };
}

function defaultTournamentDetails(user) {
  return {
    kills: Number(user?.tournamentDetails?.kills || 0),
    placement: Number(user?.tournamentDetails?.placement || 0),
    points: Number(user?.tournamentDetails?.points || 0),
    wins: Number(user?.tournamentDetails?.wins || 0),
    matchesPlayed: Number(user?.tournamentDetails?.matchesPlayed || 0),
    matches: Array.isArray(user?.tournamentDetails?.matches) ? user.tournamentDetails.matches : [],
    played: Boolean(user?.tournamentDetails?.played),
  };
}

async function buildEventsPayload(req, accountId = "") {
  const seasonNum = Utils.GetVersion(req).season;
  const currentSeason = "S" + seasonNum;
  const playerHype = accountId ? await GetPlayerHype(accountId) : 0;
  const division = getDivisionFromHype(playerHype, currentSeason);

  let rawData = "{}";
  if (fs.existsSync(eventsPath)) {
    rawData = fs.readFileSync(eventsPath, "utf-8");
  }

  const divisionString = division.tokens.map((token) => `"${token}"`).join(", ");
  const modifiedData = rawData
    .replace(/skunkyskunkyhype/g, String(playerHype))
    .replace(/skunkyskunkyseason/g, currentSeason)
    .replace(/skunkyskunkyaccountid/g, accountId || "unknown")
    .replace(/skunkyskunkydivision/g, divisionString);

  let payload;
  try {
    payload = JSON.parse(modifiedData);
  } catch {
    payload = {};
  }

  const events = Array.isArray(payload.events) ? payload.events : [];
  const templates = payload.templates && typeof payload.templates === "object" ? payload.templates : {};
  const scoringRules = payload.scoringRules && typeof payload.scoringRules === "object" ? payload.scoringRules : {};

  return {
    events,
    templates,
    scoringRules,
    player: {
      ...(payload.player || {}),
      accountId,
      persistentScores: {
        ...(payload.player?.persistentScores || {}),
        Hype: playerHype,
      },
      tokens: division.tokens,
    },
  };
}

function eventHistoryEntry({ eventId, eventWindowId, accountId, user }) {
  const details = defaultTournamentDetails(user);
  const safeWindowId = eventWindowId || "fluxlg_cup1";

  return {
    scoreKey: {
      gameId: "Fortnite",
      eventId,
      eventWindowId: safeWindowId,
      _scoreId: null,
    },
    teamId: user?.username || accountId,
    teamAccountIds: [accountId],
    liveSessionId: null,
    pointsEarned: details.points,
    eventWindowId: safeWindowId,
    score: details.points,
    gameId: "Fortnite",
    eventId,
    rank: details.played ? 1 : 0,
    percentile: 0,
    pointBreakdown: {
      eliminations: details.kills,
      placements: details.placement,
      wins: details.wins,
    },
    sessionHistory: details.matches.map((match) => ({
      endTime: new Date().toISOString(),
      sessionId: v4(),
      trackedStats: {
        MATCH_PLAYED_STAT: 1,
        PLACEMENT_STAT_INDEX: Number(match.placement || 0),
        TEAM_ELIMS_STAT_INDEX: Number(match.kills || 0),
        TIME_ALIVE_STAT: Number(match.timeAlive || 0),
        VICTORY_ROYALE_STAT: Number(match.victory || 0),
      },
    })),
    unscoredSessions: [],
  };
}

function findEvent(payload, eventId) {
  return (payload.events || []).find((event) => event.eventId === eventId) || null;
}

function eventHistoryDocument(payload, eventId, accountId, user) {
  const event = findEvent(payload, eventId);
  const windows = Array.isArray(event?.eventWindows) ? event.eventWindows : [];
  const events = windows.length > 0
    ? windows.map((window) => eventHistoryEntry({
        eventId,
        eventWindowId: window.eventWindowId,
        accountId,
        user,
      }))
    : [eventHistoryEntry({ eventId, eventWindowId: "fluxlg_cup1", accountId, user })];

  return {
    events,
    paging: {
      count: events.length,
      total: events.length,
    },
  };
}

function accountIdFromPath(value) {
  return String(value || "")
    .split("/")
    .find((part) => /^[a-zA-Z0-9_-]{16,}$/.test(part)) || "local";
}

app.get("/api/v1/events/Fortnite/download/:accountid", verifyToken, async (req, res) => {
  const accountid = req.params.accountid;

  let user;
  try {
    user = await User.findOne({ accountId: accountid }).lean();
  } catch (err) {
    log.error(`Error finding user ${accountid}: ${err.message}`);
    return res.status(500).json({ error: "Internal server error" });
  }

  if (!user) {
    return res.status(404).json({ error: "No user found" });
  }

  if (!fs.existsSync(eventsPath)) {
    log.error("Events.json not found");
    return res.status(500).json({ error: "Events file not found" });
  }

  try {
    const events = await buildEventsPayload(req, accountid);
    log.arena(`${user.username} sent an arena JSON request!`);
    return res.json(events);
  } catch (err) {
    log.error(`Error reading Events.json: ${err.message}`);
    return res.status(500).json({ error: "Error reading events file" });
  }
});

app.get("/api/v1/players/Fortnite/tokens", async (req, res) => {
  return res.json({ tokens: [] });
});

app.get("/api/v1/events/Fortnite/data/", async (req, res) => {
  const accountId = String(req.query.accountId || req.query.accountid || "").trim();
  return res.json(await buildEventsPayload(req, accountId));
});

app.get("/api/v1/events/Fortnite/:eventId", async (req, res) => {
  try {
    const accountId = String(req.query.accountId || req.query.accountid || "").trim();
    const payload = await buildEventsPayload(req, accountId);
    const event = findEvent(payload, req.params.eventId);

    if (!event) {
      return res.json({
        eventId: req.params.eventId,
        gameId: "Fortnite",
        eventWindows: [],
        eventFlags: [],
        metadata: {},
        platforms: [],
        regions: [],
      });
    }

    return res.json(event);
  } catch (error) {
    log.error(`Error in event details: ${error.message}`);
    return res.json({
      eventId: req.params.eventId,
      gameId: "Fortnite",
      eventWindows: [],
      eventFlags: [],
      metadata: {},
      platforms: [],
      regions: [],
    });
  }
});

app.get("/api/v1/events/Fortnite/:eventId/:eventWindowId", async (req, res) => {
  try {
    const accountId = String(req.query.accountId || req.query.accountid || "").trim();
    const payload = await buildEventsPayload(req, accountId);
    const event = findEvent(payload, req.params.eventId);
    const eventWindow = Array.isArray(event?.eventWindows)
      ? event.eventWindows.find((window) => window.eventWindowId === req.params.eventWindowId)
      : null;

    return res.json({
      eventId: req.params.eventId,
      gameId: "Fortnite",
      event: event || null,
      eventWindow: eventWindow || {
        eventWindowId: req.params.eventWindowId,
        eventTemplateId: "",
        beginTime: "2020-01-01T00:00:00.000Z",
        endTime: "9999-12-31T23:59:59.000Z",
      },
    });
  } catch (error) {
    log.error(`Error in event window details: ${error.message}`);
    return res.json({
      eventId: req.params.eventId,
      gameId: "Fortnite",
      event: null,
      eventWindow: {
        eventWindowId: req.params.eventWindowId,
        eventTemplateId: "",
        beginTime: "2020-01-01T00:00:00.000Z",
        endTime: "9999-12-31T23:59:59.000Z",
      },
    });
  }
});

app.get("/api/v1/events/Fortnite/:eventId/:eventWindowId/history/:accountId", async (req, res) => {
  try {
    const { eventId, eventWindowId, accountId } = req.params;
    const user = await User.findOne({ accountId }).lean();
    const payload = await buildEventsPayload(req, accountId);
    const document = eventHistoryDocument(payload, eventId, accountId, user);
    if (eventWindowId) {
      document.events = document.events.filter((event) => event.eventWindowId === eventWindowId);
      document.paging = { count: document.events.length, total: document.events.length };
    }
    return res.json(document);
  } catch (error) {
    log.error(`Error in event window history for ${req.params.accountId}: ${error.message}`);
    return res.json({ events: [], paging: { count: 0, total: 0 } });
  }
});

app.get("/api/v1/events/Fortnite/:eventId/history/:accountId", async (req, res) => {
  try {
    const { eventId, accountId } = req.params;

    const user = await User.findOne({ accountId }).lean();
    if (!user) {
      return res.json([]);
    }

    const payload = await buildEventsPayload(req, accountId);
    return res.json(eventHistoryDocument(payload, eventId, accountId, user));
  } catch (error) {
    log.error(`Error in event history for ${req.params.accountId}: ${error.message}`);
    return res.json({ events: [], paging: { count: 0, total: 0 } });
  }
});

app.get("/fortnite/api/game/v2/events/tournamentandhistory/*", async (req, res) => {
  try {
    const accountId = accountIdFromPath(req.params[0]);
    const user = await User.findOne({ accountId }).lean();
    const payload = await buildEventsPayload(req, accountId);
    const history = {};

    for (const event of payload.events) {
      if (!event?.eventId) continue;
      history[event.eventId] = eventHistoryDocument(payload, event.eventId, accountId, user);
    }

    return res.json({
      ...payload,
      history,
      tournamentAndHistory: true,
      serverTime: new Date().toISOString(),
    });
  } catch (error) {
    log.error(`Error in tournament and history: ${error.message}`);
    return res.json({
      events: [],
      templates: {},
      scoringRules: {},
      player: { tokens: [], persistentScores: {} },
      history: {},
      tournamentAndHistory: true,
      serverTime: new Date().toISOString(),
    });
  }
});

app.post("/fortnite/api/game/v2/events/v2/setSubgroup/*", (_req, res) => {
  return res.json({
    result: true,
    subgroup: "default",
    serverTime: new Date().toISOString(),
  });
});

app.get("/fortnite/api/game/v2/events/v2/:accountId", async (req, res) => {
  try {
    return res.json(await buildEventsPayload(req, req.params.accountId));
  } catch (error) {
    log.error(`Error in events v2: ${error.message}`);
    return res.json({
      events: [],
      templates: {},
      scoringRules: {},
      player: { tokens: [], persistentScores: {} },
    });
  }
});

app.get("/api/v1/leaderboards/Fortnite/:eventId/:eventWindowId/:accountId", async (req, res) => {
  try {
    const { eventId, eventWindowId, accountId } = req.params;

    const users = await User.find({}).lean();
    const leaderboard = {
      entries: [],
      eventId,
      eventWindowId,
      gameId: "Fortnite",
      page: 0,
      totalPages: 1,
      updatedTime: new Date().toISOString(),
    };

    if (!users || users.length === 0) {
      return res.json(leaderboard);
    }

    for (const user of users) {
      if (user.accountId !== accountId) continue;
      if (!user.tournamentDetails?.played) continue;

      const matches = Array.isArray(user.tournamentDetails?.matches) ? user.tournamentDetails.matches : [];
      if (matches.length === 0) continue;

      const pointBreakdown = {};
      const sessionHistory = [];
      let totalPoints = 0;
      let totalKills = 0;

      for (const match of matches) {
        if (match.placement == null || match.placementPoints == null || match.kills == null || match.killPoints == null || match.timeAlive == null || match.victory == null) continue;

        const placementKey = `PLACEMENT_STAT_INDEX:${match.placement}`;
        if (!pointBreakdown[placementKey]) {
          pointBreakdown[placementKey] = { pointsEarned: match.placementPoints, timesAchieved: 1 };
        } else {
          pointBreakdown[placementKey].pointsEarned += match.placementPoints;
          pointBreakdown[placementKey].timesAchieved += 1;
        }

        totalKills += match.kills;
        totalPoints += match.placementPoints + match.killPoints;

        sessionHistory.push({
          endTime: new Date().toISOString(),
          sessionId: v4(),
          trackedStats: {
            MATCH_PLAYED_STAT: 1,
            PLACEMENT_STAT_INDEX: match.placement,
            TEAM_ELIMS_STAT_INDEX: match.kills,
            TIME_ALIVE_STAT: match.timeAlive,
            VICTORY_ROYALE_STAT: match.victory,
          },
        });
      }

      if (totalKills > 0) {
        pointBreakdown["TEAM_ELIMS_STAT_INDEX:0"] = { pointsEarned: totalKills, timesAchieved: totalKills };
      }

      leaderboard.entries.push({
        eventId,
        eventWindowId,
        gameId: "Fortnite",
        percentile: 0,
        pointBreakdown,
        pointsEarned: totalPoints,
        rank: 1,
        score: Date.now(),
        scoreKey: { _scoreId: null, eventId, eventWindowId, gameId: "Fortnite" },
        sessionHistory,
        teamAccountIds: [user.accountId],
        teamId: user.accountId,
        unscoredSessions: {},
      });
    }

    return res.json(leaderboard);
  } catch (error) {
    log.error(`Error in leaderboard for ${req.params.accountId}: ${error.message}`);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/v1/players/Fortnite/:accountId", async (req, res) => {
  const payload = await buildEventsPayload(req, req.params.accountId);
  return res.json({
    result: true,
    region: "EU",
    lang: "en",
    season: process.env.MAIN_SEASON,
    events: payload.events,
  });
});

export default app;
