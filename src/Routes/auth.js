import express from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import kv from "../Utils/kv.js";
import Utils from "../Utils/Utils.js";
import log from "../Utils/log.js";
import tokenCreation from "../User/tokenManager/tokenCreation.js";
import { verifyClient, verifyToken } from "../User/tokenManager/tokenVerify.js";
import {
  decodeStoredToken,
  limitAccountTokens,
  pruneExpiredTokens,
  revokeAccountGameSessions,
  revokeToken,
} from "../User/tokenManager/sessionManager.js";
import User from "../User/Mongodb/Schema/user.js";
import { envBoolean, envInteger } from "../Config/env.js";

const app = express.Router();

function oauthError(res, code, message, numericCode, error = "invalid_grant", status = 400, vars = []) {
  return Utils.createError(code, message, vars, numericCode, error, status, res);
}

function clientIdFromRequest(req) {
  const authorization = String(req.headers.authorization || "");
  if (!/^basic\s+/i.test(authorization)) return null;
  try {
    const [clientId, clientSecret] = Utils.DecodeBase64(authorization.split(/\s+/)[1]).split(":");
    return clientId && clientSecret ? clientId : null;
  } catch {
    return null;
  }
}

function tokenTimes(token) {
  const decoded = jwt.decode(token);
  const expiresAtMs = decoded?.exp
    ? decoded.exp * 1000
    : DateAddHours(new Date(decoded?.creation_date || Date.now()), decoded?.hours_expire || 0).getTime();
  return {
    decoded,
    expiresIn: Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000)),
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

function limitRefreshTokens(accountId, maximum) {
  const accountTokens = global.refreshTokens.filter((entry) => entry.accountId === accountId);
  if (accountTokens.length <= maximum) return;
  const remove = new Set(accountTokens.slice(0, accountTokens.length - maximum).map((entry) => entry.token));
  global.refreshTokens = global.refreshTokens.filter((entry) => !remove.has(entry.token));
}

app.post("/account/api/oauth/token", async (req, res) => {
  pruneExpiredTokens();
  const clientId = clientIdFromRequest(req);
  if (!clientId) {
    return oauthError(
      res,
      "errors.com.epicgames.common.oauth.invalid_client",
      "The Authorization header is invalid or missing.",
      1011,
      "invalid_client",
      400
    );
  }

  const grantType = String(req.body.grant_type || "");
  const maxSessions = envInteger("GAME_MAX_SESSIONS_PER_ACCOUNT", 5, { min: 1, max: 20 });

  if (grantType === "client_credentials") {
    const ip = req.ip;
    // Keep separate clients from the same NAT alive; only replace the exact client/IP pair.
    global.clientTokens = global.clientTokens.filter((entry) => {
      if (entry.ip !== ip) return true;
      const decoded = decodeStoredToken(entry.token);
      return decoded?.clid !== clientId;
    });

    const token = tokenCreation.createClient(clientId, grantType, ip, 4);
    await Utils.UpdateTokens();
    const times = tokenTimes(token);
    return res.json({
      access_token: `eg1~${token}`,
      expires_in: times.expiresIn,
      expires_at: times.expiresAt,
      token_type: "bearer",
      client_id: clientId,
      internal_client: true,
      client_service: "fortnite",
    });
  }

  let user;
  let refreshTokenToRotate = null;

  if (grantType === "password") {
    const email = String(req.body.username || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    if (!email || !password) {
      return oauthError(
        res,
        "errors.com.epicgames.common.oauth.invalid_request",
        "Username and password are required.",
        1013,
        "invalid_request"
      );
    }

    user = await User.findOne({ email }).lean();
    const rebootBypass =
      envBoolean("ALLOW_REBOOT_PASSWORD_BYPASS", false) && /@projectreboot\.dev$/i.test(email);
    if (!user || (!rebootBypass && !(await bcrypt.compare(password, user.password)))) {
      return oauthError(
        res,
        "errors.com.epicgames.account.invalid_account_credentials",
        "Your e-mail and/or password are incorrect. Please check them and try again.",
        18031
      );
    }
  } else if (grantType === "refresh_token") {
    refreshTokenToRotate = String(req.body.refresh_token || "");
    const entry = global.refreshTokens.find((candidate) => candidate.token === refreshTokenToRotate);
    const decoded = decodeStoredToken(refreshTokenToRotate);
    if (!entry || !decoded || decoded.t !== "r") {
      if (entry) await revokeToken(refreshTokenToRotate);
      return oauthError(
        res,
        "errors.com.epicgames.account.auth_token.invalid_refresh_token",
        "The refresh token is invalid or expired.",
        18036
      );
    }
    user = await User.findOne({ accountId: entry.accountId }).lean();
  } else if (grantType === "exchange_code") {
    const exchangeCode = String(req.body.exchange_code || "");
    const index = global.exchangeCodes.findIndex((entry) => entry.exchange_code === exchangeCode);
    if (!exchangeCode || index === -1) {
      return oauthError(
        res,
        "errors.com.epicgames.account.oauth.exchange_code_not_found",
        "The exchange code was not found or is no longer valid.",
        18057
      );
    }
    const [exchange] = global.exchangeCodes.splice(index, 1);
    user = await User.findOne({ accountId: exchange.accountId }).lean();
  } else {
    return oauthError(
      res,
      "errors.com.epicgames.common.oauth.unsupported_grant_type",
      `Unsupported grant type: ${grantType || "missing"}`,
      1016,
      "unsupported_grant_type"
    );
  }

  if (!user) {
    return oauthError(
      res,
      "errors.com.epicgames.account.oauth.account_not_found",
      "The account does not exist.",
      18056
    );
  }
  if (user.banned) {
    return oauthError(
      res,
      "errors.com.epicgames.account.account_not_active",
      "This account is not active.",
      -1,
      undefined
    );
  }

  if (refreshTokenToRotate) {
    // Token refreshes must not close XMPP or invalidate the old access token while
    // Fortnite is still finishing concurrent lobby/matchmaking requests.
    global.refreshTokens = global.refreshTokens.filter((entry) => entry.token !== refreshTokenToRotate);
  } else if (envBoolean("GAME_SINGLE_SESSION_PER_ACCOUNT", false)) {
    await revokeAccountGameSessions(user.accountId, { closeXmpp: true });
  }

  const deviceId = uuidv4().replace(/-/g, "");
  const accessToken = tokenCreation.createAccess(user, clientId, grantType, deviceId, 8);
  const refreshToken = tokenCreation.createRefresh(user, clientId, grantType, deviceId, 24);
  limitAccountTokens(user.accountId, maxSessions);
  limitRefreshTokens(user.accountId, maxSessions);
  await Utils.UpdateTokens();

  const accessTimes = tokenTimes(accessToken);
  const refreshTimes = tokenTimes(refreshToken);
  log.info(`Issued game session for account ${user.accountId} using ${grantType}.`);

  const response = {
    access_token: `eg1~${accessToken}`,
    expires_in: accessTimes.expiresIn,
    expires_at: accessTimes.expiresAt,
    token_type: "bearer",
    refresh_token: `eg1~${refreshToken}`,
    refresh_expires: refreshTimes.expiresIn,
    refresh_expires_at: refreshTimes.expiresAt,
    account_id: user.accountId,
    client_id: clientId,
    internal_client: true,
    client_service: "fortnite",
    displayName: user.username,
    app: "fortnite",
    in_app_id: user.accountId,
    device_id: deviceId,
  };

  res.json(response);
  if (user.discordId) {
    await kv.set(user.discordId, "false").catch(() => {});
  }
});

app.get("/account/api/oauth/verify", verifyClient, (req, res) => {
  const decoded = req.auth.decoded;
  const expiresAtMs = decoded.exp * 1000;
  const response = {
    token: req.auth.token,
    session_id: decoded.jti,
    token_type: "bearer",
    client_id: decoded.clid,
    internal_client: Boolean(decoded.ic),
    client_service: decoded.clsvc || "fortnite",
    expires_in: Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000)),
    expires_at: new Date(expiresAtMs).toISOString(),
    auth_method: decoded.am,
  };

  if (req.user) {
    Object.assign(response, {
      account_id: req.user.accountId,
      display_name: req.user.username,
      app: decoded.app || "fortnite",
      in_app_id: decoded.iai || req.user.accountId,
      device_id: decoded.dvid,
    });
  }
  return res.json(response);
});

app.get("/account/api/oauth/exchange", verifyToken, (req, res) => {
  const exchangeCode = uuidv4().replace(/-/g, "");
  global.exchangeCodes.push({ accountId: req.user.accountId, exchange_code: exchangeCode });
  setTimeout(() => {
    global.exchangeCodes = global.exchangeCodes.filter((entry) => entry.exchange_code !== exchangeCode);
  }, 300000).unref?.();
  return res.json({ expiresInSeconds: 300, code: exchangeCode, creatingClientId: req.auth.decoded.clid });
});

function shouldRevokeSessionKills() {
  // Older Fortnite clients can call the session-kill route during normal queue / travel
  // cleanup. Treating every request as a real logout removes the still-active game
  // access token and causes the next profile/cloudstorage request to fail with 1032.
  return envBoolean("GAME_REVOKE_ON_SESSION_KILL", false);
}

app.delete("/account/api/oauth/sessions/kill/:accessToken", async (req, res) => {
  if (shouldRevokeSessionKills()) {
    await revokeToken(decodeURIComponent(req.params.accessToken), { closeXmpp: false });
  }
  return res.status(204).end();
});

app.delete("/account/api/oauth/sessions/kill", verifyToken, async (req, res) => {
  if (shouldRevokeSessionKills()) {
    await revokeAccountGameSessions(req.user.accountId, { closeXmpp: false });
  }
  return res.status(204).end();
});

app.post(
  "/fortnite/api/game/v2/profileToken/verify/:accountId",
  verifyToken,
  (req, res) => {
    if (req.params.accountId !== req.user.accountId) return res.status(403).end();
    return res.status(204).end();
  }
);

app.post("/auth/v1/oauth/token", (_req, res) => {
  res.json({
    access_token: `eg1~${uuidv4().replace(/-/g, "")}`,
    token_type: "bearer",
    expires_at: new Date(Date.now() + 3599 * 1000).toISOString(),
    expires_in: 3599,
    features: ["AntiCheat", "Connect", "ContentService", "Ecom", "Inventories", "LockerService", "Matchmaking Service"],
    organization_id: "Flux",
    product_id: "prod-fn",
    sandbox_id: "fn",
    deployment_id: "62a9473a2dca46b29ccf17577fcf42d7",
    organization_user_id: "Flux",
    product_user_id: "Flux",
    product_user_id_created: false,
    id_token: `eg1~${uuidv4().replace(/-/g, "")}`,
  });
});

app.post("/epic/oauth/v2/token", async (req, res) => {
  const clientId = clientIdFromRequest(req);
  const refreshToken = String(req.body.refresh_token || "");
  const entry = global.refreshTokens.find((candidate) => candidate.token === refreshToken);
  if (!clientId || !entry || !decodeStoredToken(refreshToken)) {
    return oauthError(
      res,
      "errors.com.epicgames.account.auth_token.invalid_refresh_token",
      "The refresh token is invalid or expired.",
      18036
    );
  }

  const user = await User.findOne({ accountId: entry.accountId }).lean();
  if (!user || user.banned) return res.status(401).json({ error: "invalid_account" });
  return res.json({
    scope: "basic_profile friends_list openid presence",
    token_type: "bearer",
    access_token: uuidv4(),
    refresh_token: uuidv4(),
    id_token: uuidv4(),
    expires_in: 7200,
    expires_at: new Date(Date.now() + 7200 * 1000).toISOString(),
    refresh_expires_in: 28800,
    refresh_expires_at: new Date(Date.now() + 28800 * 1000).toISOString(),
    account_id: user.accountId,
    client_id: clientId,
    application_id: uuidv4(),
    selected_account_id: user.accountId,
    merged_accounts: [],
  });
});

app.post("/datarouter/api/v1/public/data/clients", (_req, res) => {
  res.status(204).end();
});

export function DateAddHours(pdate, number) {
  const date = new Date(pdate);
  date.setHours(date.getHours() + Number(number || 0));
  return date;
}

export default app;
