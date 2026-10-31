import express from "express";
import qs from "qs";
import Utils from "../Utils/Utils.js";
import { verifyToken } from "../User/tokenManager/tokenVerify.js";
import { envInteger, envList, envString } from "../Config/env.js";
import {
  normalizeMatchmakerUrl,
  normalizeRegion,
  parseGameServerAddress,
} from "../matchmaker/src/protocol.js";

const app = express.Router();
const buildUniqueId = new Map();

function supportedRegions() {
  return envList("MATCHMAKER_SUPPORTED_REGIONS", ["NAE", "EU"]).map((region) => region.toUpperCase());
}

function gameServerForRegion(region) {
  return envString(`GAME_SERVER_${region}`, envString(`${region}_IP`));
}

app.get("/fortnite/api/matchmaking/session/findPlayer/*", (_req, res) => {
  res.status(200).end();
});

app.get(
  "/fortnite/api/game/v2/matchmakingservice/ticket/player/*",
  verifyToken,
  async (req, res) => {
    const parsedQuery = qs.parse(req.url.split("?")[1] || "", { ignoreQueryPrefix: true });
    const playerCustomKey = parsedQuery["player.option.customKey"];
    const bucketId = parsedQuery.bucketId;

    if (typeof bucketId !== "string" || bucketId.split(":").length !== 4) {
      return Utils.createError(
        "errors.com.epicgames.common.matchmaking.invalid_bucket",
        "The matchmaking bucket was invalid.",
        [],
        1013,
        "invalid_request",
        400,
        res
      );
    }

    if (typeof playerCustomKey === "string" && playerCustomKey.trim()) {
      return Utils.createError(
        "errors.com.epicgames.common.matchmaking.code.not_found",
        "Custom matchmaking codes are not supported.",
        [],
        1013,
        "invalid_code",
        404,
        res
      );
    }

    const [buildId, , rawRegion, playlist] = bucketId.split(":");
    const regions = supportedRegions();
    const region = normalizeRegion(rawRegion, regions, envString("MATCHMAKER_DEFAULT_REGION", "NAE"));
    if (!regions.includes(String(rawRegion).toUpperCase())) {
      return Utils.createError(
        "errors.com.epicgames.common.matchmaking.region_not_found",
        `The region '${rawRegion}' is not configured.`,
        [rawRegion],
        1013,
        "invalid_region",
        400,
        res
      );
    }

    const configuredGameServer = gameServerForRegion(region);
    const gameServer = parseGameServerAddress(
      configuredGameServer,
      envInteger("GAME_SERVER_DEFAULT_PORT", 7777, { min: 1, max: 65535 })
    );
    if (!gameServer) {
      return Utils.createError(
        "errors.com.epicgames.common.matchmaking.config_error",
        `No valid game server is configured for region ${region}.`,
        [],
        1014,
        "invalid_config",
        500,
        res
      );
    }

    const memory = Utils.GetVersion(req);
    await Promise.all([
      global.kv.set(`playerPlaylist:${req.user.accountId}`, playlist),
      global.kv.set(`playerRegion:${req.user.accountId}`, region),
    ]);
    buildUniqueId.set(req.user.accountId, buildId);

    const publicMatchmakerUrl = normalizeMatchmakerUrl(
      envString("MATCHMAKER_PUBLIC_URL", envString("MATCHMAKER_IP", "127.0.0.1")),
      envInteger("MATCHMAKER_WS_PORT", 81, { min: 1, max: 65535 })
    );

    return res.json({
      serviceUrl: publicMatchmakerUrl,
      ticketType: "mms-player",
      payload: `account ${region} ${playlist} ${memory.season}`,
    });
  }
);

app.delete(
  "/fortnite/api/game/v2/matchmakingservice/ticket/player/:accountId",
  verifyToken,
  async (req, res) => {
    if (req.params.accountId !== req.user.accountId) return res.status(403).end();
    await Promise.all([
      global.kv.delete(`playerPlaylist:${req.user.accountId}`),
      global.kv.delete(`playerRegion:${req.user.accountId}`),
    ]).catch(() => {});
    buildUniqueId.delete(req.user.accountId);
    return res.status(204).end();
  }
);

app.get(
  "/fortnite/api/game/v2/matchmaking/account/:accountId/session/:sessionId",
  verifyToken,
  (req, res) => {
    if (req.params.accountId !== req.user.accountId) return res.status(403).end();
    return res.json({
      accountId: req.params.accountId,
      sessionId: req.params.sessionId,
      key: "none",
    });
  }
);

app.get(
  "/fortnite/api/matchmaking/session/:sessionId",
  verifyToken,
  async (req, res) => {
    const playlist = await global.kv.get(`playerPlaylist:${req.user.accountId}`);
    const storedRegion = await global.kv.get(`playerRegion:${req.user.accountId}`);
    const region = normalizeRegion(
      storedRegion,
      supportedRegions(),
      envString("MATCHMAKER_DEFAULT_REGION", "NAE")
    );
    const gameServer = parseGameServerAddress(
      gameServerForRegion(region),
      envInteger("GAME_SERVER_DEFAULT_PORT", 7777, { min: 1, max: 65535 })
    );

    if (!gameServer) {
      return Utils.createError(
        "errors.com.epicgames.common.matchmaking.config_error",
        `No valid game server is configured for region ${region}.`,
        [],
        1014,
        "invalid_config",
        500,
        res
      );
    }

    const maxPlayers = envInteger("GAME_SERVER_MAX_PLAYERS", 100, { min: 1, max: 1000 });
    const beaconPort = envInteger("GAME_SERVER_BEACON_PORT", 15009, { min: 1, max: 65535 });
    const sessionKey = envString("MATCHMAKER_SESSION_KEY", "none");
    const serverLabel = `[DS]flux-${region.toLowerCase()}-${req.params.sessionId.slice(0, 8)}`;

    return res.json({
      id: req.params.sessionId,
      ownerId: req.user.accountId,
      ownerName: serverLabel,
      serverName: serverLabel,
      serverAddress: gameServer.host,
      serverPort: gameServer.port,
      maxPublicPlayers: maxPlayers,
      openPublicPlayers: maxPlayers,
      maxPrivatePlayers: 0,
      openPrivatePlayers: 0,
      attributes: {
        REGION_s: region,
        GAMEMODE_s: "FORTATHENA",
        ALLOWBROADCASTING_b: true,
        SUBREGION_s: region === "EU" ? "GB" : "US",
        DCID_s: `FLUX-${region}`,
        tenant_s: "Fortnite",
        MATCHMAKINGPOOL_s: "Any",
        STORMSHIELDDEFENSETYPE_i: 0,
        HOTFIXVERSION_i: 0,
        PLAYLISTNAME_s: playlist || "Playlist_DefaultSolo",
        SESSIONKEY_s: sessionKey,
        TENANT_s: "Fortnite",
        BEACONPORT_i: beaconPort,
      },
      publicPlayers: [],
      privatePlayers: [],
      totalPlayers: 0,
      allowJoinInProgress: false,
      shouldAdvertise: false,
      isDedicated: true,
      usesStats: false,
      allowInvites: false,
      usesPresence: false,
      allowJoinViaPresence: true,
      allowJoinViaPresenceFriendsOnly: false,
      buildUniqueId: buildUniqueId.get(req.user.accountId) || "0",
      lastUpdated: new Date().toISOString(),
      started: false,
    });
  }
);

app.post("/fortnite/api/matchmaking/session/:sessionId/join", verifyToken, (_req, res) => {
  res.status(204).end();
});

app.post("/fortnite/api/matchmaking/session/:sessionId/heartbeat", verifyToken, (_req, res) => {
  res.status(204).end();
});

app.post("/fortnite/api/matchmaking/session/matchMakingRequest", verifyToken, (_req, res) => {
  res.json([]);
});

export default app;
