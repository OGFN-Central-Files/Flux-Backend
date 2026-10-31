import jwt from "jsonwebtoken";
import User from "../../User/Mongodb/Schema/user.js";
import Utils from "../../Utils/Utils.js";
import log from "../../Utils/log.js";

function extractBearerToken(req) {
  const authorization = String(req.headers?.authorization || "").trim();
  const match = authorization.match(/^bearer\s+(eg1~.+)$/i);
  return match?.[1] || null;
}

function verifyJwt(storedToken) {
  const raw = String(storedToken || "").replace(/^eg1~/, "");
  return jwt.verify(raw, global.JWT_SECRET);
}

function removeStoredToken(storedToken) {
  const beforeAccess = global.accessTokens.length;
  const beforeClient = global.clientTokens.length;
  global.accessTokens = global.accessTokens.filter((entry) => entry.token !== storedToken);
  global.clientTokens = global.clientTokens.filter((entry) => entry.token !== storedToken);
  if (beforeAccess !== global.accessTokens.length || beforeClient !== global.clientTokens.length) {
    void Utils.UpdateTokens();
  }
}

function authorizationError(req, res) {
  return Utils.createError(
    "errors.com.epicgames.common.authorization.authorization_failed",
    `Authorization failed for ${req.originalUrl}`,
    [req.originalUrl],
    1032,
    undefined,
    401,
    res
  );
}

async function loadUserForToken(decodedToken, req, res) {
  if (!decodedToken?.sub) throw new Error("Access token has no account subject.");
  const user = await User.findOne({ accountId: decodedToken.sub }).lean();
  if (!user) throw new Error("Account no longer exists.");
  if (user.banned) {
    Utils.createError(
      "errors.com.epicgames.account.account_not_active",
      "You have been permanently banned from Flux.",
      [],
      -1,
      undefined,
      400,
      res
    );
    return null;
  }
  req.user = user;
  return user;
}

async function verifyToken(req, res, next) {
  const storedToken = extractBearerToken(req);
  if (!storedToken) return authorizationError(req, res);

  try {
    const tokenEntry = global.accessTokens.find((entry) => entry.token === storedToken);
    if (!tokenEntry) throw new Error("Access token is not active.");

    const decodedToken = verifyJwt(storedToken);
    if (decodedToken.am === "client_credentials" || decodedToken.t === "r") {
      throw new Error("A user access token is required.");
    }

    const user = await loadUserForToken(decodedToken, req, res);
    if (!user) return;
    req.auth = { token: storedToken, decoded: decodedToken, type: "access" };
    return next();
  } catch (err) {
    // Do not erase tokens just because one request failed auth. A queue/login race or
    // an old-client cleanup request should not force the whole game session offline.
    log.debug(`Game token rejected for ${req.originalUrl}: ${err.message}`);
    return authorizationError(req, res);
  }
}

async function verifyClient(req, res, next) {
  const storedToken = extractBearerToken(req);
  if (!storedToken) return authorizationError(req, res);

  try {
    const accessEntry = global.accessTokens.find((entry) => entry.token === storedToken);
    const clientEntry = global.clientTokens.find((entry) => entry.token === storedToken);
    if (!accessEntry && !clientEntry) throw new Error("Token is not active.");

    const decodedToken = verifyJwt(storedToken);
    if (accessEntry) {
      const user = await loadUserForToken(decodedToken, req, res);
      if (!user) return;
    }

    req.auth = {
      token: storedToken,
      decoded: decodedToken,
      type: accessEntry ? "access" : "client",
    };
    return next();
  } catch (err) {
    log.debug(`Client token rejected for ${req.originalUrl}: ${err.message}`);
    return authorizationError(req, res);
  }
}

function DateAddHours(pdate, number) {
  const date = new Date(pdate);
  date.setHours(date.getHours() + Number(number || 0));
  return date;
}

export { DateAddHours, extractBearerToken, verifyClient, verifyToken, verifyJwt };
