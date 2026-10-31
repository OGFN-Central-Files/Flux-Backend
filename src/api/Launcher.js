import express from "express";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import User from "../User/Mongodb/Schema/user.js";
import Utils from "../Utils/Utils.js";
import log from "../Utils/log.js";
import { envBoolean, envInteger, envString } from "../Config/env.js";

const router = express.Router();
const tokenIssuer = envString("LAUNCHER_TOKEN_ISSUER", `${envString("BACKEND_NAME", "Flux")}-launcher`);
const tokenAudience = envString("LAUNCHER_TOKEN_AUDIENCE", "flux-launcher");
const discordApi = "https://discord.com/api/v10";

function getLauncherSecret() {
  const secret = envString("LAUNCHER_JWT_SECRET", global.JWT_SECRET || "");
  if (!secret) throw new Error("LAUNCHER_JWT_SECRET is not configured");
  if (secret.length < 32) log.warn("LAUNCHER_JWT_SECRET should be at least 32 characters long.");
  return secret;
}

function publicUser(user) {
  return {
    accountId: user.accountId,
    username: user.username,
    email: user.email,
    discordId: user.discordId,
    created: user.created,
    mfa: Boolean(user.mfa),
    canCreateCodes: Boolean(user.canCreateCodes),
    isOnline: Boolean(user.isOnline),
  };
}

function signLauncherToken(user) {
  return jwt.sign(
    {
      sub: user.accountId,
      accountId: user.accountId,
      username: user.username,
      tokenType: "launcher_access",
      tokenVersion: Number(user.launcherTokenVersion || 0),
    },
    getLauncherSecret(),
    {
      algorithm: "HS256",
      audience: tokenAudience,
      issuer: tokenIssuer,
      expiresIn: envString("LAUNCHER_TOKEN_EXPIRES_IN", "7d"),
      jwtid: crypto.randomUUID(),
    }
  );
}

function launcherLoginResponse(user, accessToken) {
  const decoded = jwt.decode(accessToken);
  return {
    success: true,
    message: "Login successful",
    username: user.username,
    email: user.email,
    accountId: user.accountId,
    accessToken,
    tokenType: "Bearer",
    expiresAt: new Date(decoded.exp * 1000).toISOString(),
    user: publicUser(user),
  };
}

export async function requireLauncherAuth(req, res, next) {
  const authorization = req.headers.authorization || "";
  const [scheme, token] = authorization.split(/\s+/, 2);

  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return res.status(401).json({
      error: "unauthorized",
      message: "A launcher bearer token is required.",
    });
  }

  try {
    const payload = jwt.verify(token, getLauncherSecret(), {
      algorithms: ["HS256"],
      audience: tokenAudience,
      issuer: tokenIssuer,
    });

    if (payload.tokenType !== "launcher_access" || !payload.accountId) {
      throw new Error("Invalid launcher token");
    }

    const user = await User.findOne({ accountId: payload.accountId }).lean();
    if (
      !user ||
      user.banned ||
      Number(payload.tokenVersion || 0) !== Number(user.launcherTokenVersion || 0)
    ) {
      return res.status(401).json({
        error: "unauthorized",
        message: "This launcher session is no longer valid.",
      });
    }

    req.launcherUser = user;
    req.launcherToken = payload;
    return next();
  } catch (error) {
    log.debug(`Rejected launcher token: ${error.message}`);
    return res.status(401).json({
      error: "unauthorized",
      message: "The launcher token is invalid or expired.",
    });
  }
}

const loginLimiter = rateLimit({
  windowMs: envInteger("LAUNCHER_LOGIN_WINDOW_MINUTES", 15, { min: 1, max: 1440 }) * 60000,
  max: envInteger("LAUNCHER_LOGIN_MAX_ATTEMPTS", 10, { min: 1, max: 1000 }),
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: envBoolean("LAUNCHER_LOGIN_SKIP_SUCCESSFUL", true),
  message: {
    success: false,
    error: "too_many_requests",
    message: "Too many login attempts. Try again later.",
  },
});

async function login(req, res) {
  const input = req.method === "GET" ? req.query : req.body;
  const identifier = String(input?.identifier ?? input?.email ?? input?.username ?? "")
    .trim()
    .toLowerCase();
  const password = String(input?.password ?? "");

  if (!identifier || !password) {
    return res.status(400).json({
      success: false,
      error: "invalid_request",
      message: "Email/username and password are required.",
    });
  }

  if (identifier.length > 254 || password.length > 127) {
    return res.status(400).json({
      success: false,
      error: "invalid_request",
      message: "The supplied credentials are not valid.",
    });
  }

  try {
    const user = await User.findOne({
      $or: [{ email: identifier }, { username_lower: identifier }],
    }).lean();

    // Run a real bcrypt comparison even when the user is absent to reduce account-enumeration timing differences.
    const fallbackHash = "$2b$10$K7L1OJ45/4Y2nIvhRVpCe.FSm5W4Z0m2Xj7gQv6sP2Q5Vx9D0fR7W";
    const passwordMatches = await bcrypt.compare(password, user?.password || fallbackHash);

    if (!user || !passwordMatches) {
      return res.status(401).json({
        success: false,
        error: "invalid_credentials",
        message: "The email/username or password is incorrect.",
      });
    }

    if (user.banned) {
      return res.status(403).json({
        success: false,
        error: "account_banned",
        message: "This account is banned.",
      });
    }

    const accessToken = signLauncherToken(user);
    log.launcher(`Login successful for account ${user.accountId}`);

    return res.status(200).json(launcherLoginResponse(user, accessToken));
  } catch (error) {
    log.error(`Launcher login failed: ${error.message}`);
    return res.status(500).json({
      success: false,
      error: "internal_server_error",
      message: "Unable to log in right now.",
    });
  }
}

async function fetchDiscordUser(code, redirectUri) {
  const tokenResponse = await fetch(`${discordApi}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: envString("CLIENT_ID"),
      client_secret: envString("CLIENT_SECRET"),
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
    signal: AbortSignal.timeout(envInteger("DISCORD_OAUTH_TIMEOUT_MS", 10000, { min: 1000, max: 60000 })),
  });

  if (!tokenResponse.ok) {
    throw new Error(`Discord token exchange failed with HTTP ${tokenResponse.status}`);
  }

  const token = await tokenResponse.json();
  const userResponse = await fetch(`${discordApi}/users/@me`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
    signal: AbortSignal.timeout(envInteger("DISCORD_OAUTH_TIMEOUT_MS", 10000, { min: 1000, max: 60000 })),
  });

  if (!userResponse.ok) {
    throw new Error(`Discord user lookup failed with HTTP ${userResponse.status}`);
  }

  return userResponse.json();
}

export function discordCallback(req, res) {
  const code = String(req.query?.code || "").trim();
  const state = String(req.query?.state || "").trim();
  const error = String(req.query?.error || "").trim();
  const launcherRedirectUri = envString(
    "LAUNCHER_DISCORD_REDIRECT_URI",
    "http://localhost:38987/"
  );

  log.launcher(
    `Discord callback received: hasCode=${Boolean(code)} hasState=${Boolean(state)} error=${error || "none"}`
  );

  if (error) {
    const redirect = new URL(launcherRedirectUri);
    redirect.searchParams.set("error", "discord_oauth_denied");
    redirect.searchParams.set("state", state);
    log.launcher(`Discord callback denied; forwarding to launcher listener at ${launcherRedirectUri}`);
    return res.redirect(302, redirect.toString());
  }

  if (!code || !state) {
    log.warn("Discord callback rejected because code or state was missing.");
    return res.status(400).send("Discord OAuth callback is missing code or state.");
  }

  const redirect = new URL(launcherRedirectUri);
  redirect.searchParams.set("code", code);
  redirect.searchParams.set("state", state);
  log.launcher(`Discord callback forwarding OAuth result to launcher listener at ${launcherRedirectUri}`);
  return res.redirect(302, redirect.toString());
}

async function discordLogin(req, res) {
  const code = String(req.body?.code || "").trim();
  const redirectUri = String(req.body?.redirectUri || req.body?.redirect_uri || "").trim();
  const authorizeRedirectUri = envString(
    "LAUNCHER_DISCORD_AUTHORIZE_REDIRECT_URI",
    "http://127.0.0.1:3551/api/launcher/discord/callback"
  );

  if (!envString("CLIENT_ID") || !envString("CLIENT_SECRET")) {
    log.warn("Launcher Discord login requested but CLIENT_ID or CLIENT_SECRET is missing.");
    return res.status(503).json({
      success: false,
      error: "discord_oauth_not_configured",
      message: "Discord OAuth is not configured.",
    });
  }

  if (!code || redirectUri !== authorizeRedirectUri) {
    log.warn(
      `Launcher Discord login rejected: hasCode=${Boolean(code)} redirectMatches=${redirectUri === authorizeRedirectUri} receivedRedirect=${redirectUri || "none"} expectedRedirect=${authorizeRedirectUri}`
    );
    return res.status(400).json({
      success: false,
      error: "invalid_request",
      message: "A Discord OAuth code and the configured Discord redirect URI are required.",
    });
  }

  try {
    const discordUser = await fetchDiscordUser(code, redirectUri);
    const discordId = String(discordUser.id || "").trim();
    log.launcher(`Discord user lookup completed: discordId=${discordId || "missing"}`);
    if (!/^\d{6,32}$/.test(discordId)) {
      return res.status(400).json({
        success: false,
        error: "invalid_discord_user",
        message: "Discord did not return a valid user.",
      });
    }

    let user = await User.findOne({ discordId }).lean();

    if (!user) {
      const baseName = String(discordUser.global_name || discordUser.username || "Player");
      const email = String(discordUser.email || `${discordId}@discord.local`).toLowerCase();
      const password = crypto.randomBytes(18).toString("base64url");
      const created = await Utils.CreateUser(discordId, baseName, email, password, false);

      if (created.status >= 400) {
        return res.status(created.status).json({
          success: false,
          error: "account_create_failed",
          message: created.message || "Could not create a launcher account.",
        });
      }

      user = await User.findOne({ discordId }).lean();
    }

    if (!user || user.banned) {
      return res.status(403).json({
        success: false,
        error: "account_unavailable",
        message: "This account is not available.",
      });
    }

    const accessToken = signLauncherToken(user);
    log.launcher(`Discord login successful for account ${user.accountId}`);
    return res.status(200).json(launcherLoginResponse(user, accessToken));
  } catch (error) {
    log.error(`Launcher Discord login failed: ${error.message}`);
    return res.status(500).json({
      success: false,
      error: "discord_oauth_failed",
      message: "Unable to sign in with Discord right now.",
    });
  }
}

router.post("/login", loginLimiter, login);
router.post("/auth/login", loginLimiter, login);
router.post("/discord/login", loginLimiter, discordLogin);
router.post("/auth/discord/login", loginLimiter, discordLogin);
if (envBoolean("LAUNCHER_ENABLE_LEGACY_GET_LOGIN", false)) {
  router.get("/login", loginLimiter, login);
}

router.get("/me", requireLauncherAuth, (req, res) => {
  return res.status(200).json({ user: publicUser(req.launcherUser) });
});
router.get("/auth/me", requireLauncherAuth, (req, res) => {
  return res.status(200).json({ user: publicUser(req.launcherUser) });
});

router.get("/exchange-code", requireLauncherAuth, (req, res) => {
  const exchangeCode = crypto.randomUUID().replace(/-/g, "");
  global.exchangeCodes.push({
    accountId: req.launcherUser.accountId,
    exchange_code: exchangeCode,
  });
  setTimeout(() => {
    global.exchangeCodes = global.exchangeCodes.filter(
      (entry) => entry.exchange_code !== exchangeCode
    );
  }, 300000).unref?.();
  return res.status(200).json({ code: exchangeCode, expiresInSeconds: 300 });
});

router.get("/auth/exchange-code", requireLauncherAuth, (req, res) => {
  const exchangeCode = crypto.randomUUID().replace(/-/g, "");
  global.exchangeCodes.push({
    accountId: req.launcherUser.accountId,
    exchange_code: exchangeCode,
  });
  setTimeout(() => {
    global.exchangeCodes = global.exchangeCodes.filter(
      (entry) => entry.exchange_code !== exchangeCode
    );
  }, 300000).unref?.();
  return res.status(200).json({ code: exchangeCode, expiresInSeconds: 300 });
});

router.post("/logout", requireLauncherAuth, async (req, res) => {
  await User.updateOne(
    { accountId: req.launcherUser.accountId },
    { $inc: { launcherTokenVersion: 1 } }
  );
  return res.status(204).end();
});

export default router;
