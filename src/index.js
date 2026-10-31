import "dotenv/config";
import express from "express";
import mongoose from "mongoose";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { dirname } from "dirname-filename-esm";
import { v4 as uuidv4 } from "uuid";
import kv from "./Utils/kv.js";
import Utils from "./Utils/Utils.js";
import log from "./Utils/log.js";
import User from "./User/Mongodb/Schema/user.js";
import launcherRouter, { discordCallback as launcherDiscordCallback } from "./api/Launcher.js";
import shopRouter from "./api/Shop.js";
import leaderboardRouter from "./api/Leaderboard.js";
import {
  envBoolean,
  envInteger,
  envString,
  requireEnvironment,
} from "./Config/env.js";

const __dirname = dirname(import.meta);
const app = express();
const port = envInteger("PORT", 3551, { min: 1, max: 65535 });

requireEnvironment(["MONGO_URI"]);
if (envBoolean("DISCORD_BOT_ENABLED", true)) requireEnvironment(["BOT_TOKEN"]);
if (envBoolean("DISCORD_PROFILE_API_ENABLED", false)) requireEnvironment(["API_KEY"]);
if (envString("NODE_ENV", "development").toLowerCase() === "production") {
  requireEnvironment(["GAME_JWT_SECRET", "LAUNCHER_JWT_SECRET"]);
}

global.kv = kv;
const configuredGameSecret = envString("GAME_JWT_SECRET", envString("API_KEY"));
global.JWT_SECRET = configuredGameSecret || uuidv4();
if (!configuredGameSecret) {
  log.warn("GAME_JWT_SECRET is not configured; a temporary development secret was generated for this process.");
}
global.accessTokens = [];
global.refreshTokens = [];
global.clientTokens = [];
global.smartXMPP = false;
global.exchangeCodes = [];
global.Clients ||= [];

function tokenStorePath() {
  const configured = envString("TOKEN_STORE_PATH", "tokens.json");
  return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
}

function loadTokenStore() {
  const filePath = tokenStorePath();
  const emptyStore = { accessTokens: [], refreshTokens: [], clientTokens: [] };

  try {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(emptyStore, null, 2));
      return emptyStore;
    }

    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const store = {
      accessTokens: Array.isArray(parsed?.accessTokens) ? parsed.accessTokens : [],
      refreshTokens: Array.isArray(parsed?.refreshTokens) ? parsed.refreshTokens : [],
      clientTokens: Array.isArray(parsed?.clientTokens) ? parsed.clientTokens : [],
    };

    const now = Date.now();
    for (const key of ["accessTokens", "refreshTokens", "clientTokens"]) {
      store[key] = store[key].filter((entry) => {
        try {
          const raw = String(entry?.token || "").replace(/^eg1~/, "");
          const decoded = jwt.decode(raw);
          if (!decoded) return false;
          if (decoded.exp) return decoded.exp * 1000 > now;
          if (decoded.creation_date && decoded.hours_expire) {
            return new Date(decoded.creation_date).getTime() + decoded.hours_expire * 3600000 > now;
          }
          return true;
        } catch {
          return false;
        }
      });
    }

    fs.writeFileSync(filePath, JSON.stringify(store, null, 2));
    return store;
  } catch (error) {
    log.error(`Token store was invalid and has been reset: ${error.message}`);
    fs.writeFileSync(filePath, JSON.stringify(emptyStore, null, 2));
    return emptyStore;
  }
}

const tokens = loadTokenStore();
global.accessTokens = tokens.accessTokens;
global.refreshTokens = tokens.refreshTokens;
global.clientTokens = tokens.clientTokens;

app.disable("x-powered-by");
if (envBoolean("TRUST_PROXY", false)) app.set("trust proxy", 1);

app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  });
  next();
});

const bodyLimit = envString("HTTP_BODY_LIMIT", "1mb");
app.use(express.json({ limit: bodyLimit }));
app.use(express.urlencoded({ extended: true, limit: bodyLimit }));

if (envBoolean("GLOBAL_RATE_LIMIT_ENABLED", true)) {
  app.use(
    rateLimit({
      windowMs: envInteger("GLOBAL_RATE_LIMIT_WINDOW_MINUTES", 15, { min: 1, max: 1440 }) * 60000,
      max: envInteger("GLOBAL_RATE_LIMIT_MAX", 1500, { min: 50, max: 100000 }),
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req) => req.path === "/" || req.path === "/health",
    })
  );
}

app.get(["/", "/health"], (_req, res) => {
  res.status(200).json({
    status: "ok",
    name: envString("BACKEND_NAME", "Flux"),
    uptime: Math.floor(process.uptime()),
    database: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
    discord: global.discordClient?.isReady?.() ? "connected" : "disconnected",
  });
});

app.get("/discord-profile/:discordId", async (req, res) => {
  if (!envBoolean("DISCORD_PROFILE_API_ENABLED", false)) {
    return res.status(404).json({ error: "not_found" });
  }

  const expectedKey = envString("API_KEY");
  if (!expectedKey || req.get("x-api-key") !== expectedKey) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const user = await User.findOne({ discordId: req.params.discordId }).lean();
    if (!user) return res.status(404).json({ error: "user_not_found" });

    return res.status(200).json({
      accountId: user.accountId,
      username: user.username,
      email: user.email,
      mfa: Boolean(user.mfa),
      canCreateCodes: Boolean(user.canCreateCodes),
      banned: Boolean(user.banned),
    });
  } catch (error) {
    log.error(`Discord profile lookup failed: ${error.message}`);
    return res.status(500).json({ error: "internal_server_error" });
  }
});

const launcherCors = cors({
  origin: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-API-Key",
    envString("LAUNCHER_API_KEY_HEADER", "x-launcher-secret"),
  ],
  maxAge: 86400,
});

function constantTimeEquals(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");

  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function requireLauncherApiKey(req, res, next) {
  const expectedKey = envString("LAUNCHER_API_KEY");
  const requireKey = envBoolean("LAUNCHER_API_KEY_REQUIRED", Boolean(expectedKey));

  if (!requireKey) return next();

  if (!expectedKey) {
    log.error("LAUNCHER_API_KEY_REQUIRED is enabled, but LAUNCHER_API_KEY is empty.");
    return res.status(503).json({
      error: "launcher_api_key_not_configured",
      message: "Launcher API key validation is not configured.",
    });
  }

  const headerName = envString("LAUNCHER_API_KEY_HEADER", "x-launcher-secret");
  const suppliedKey = req.get(headerName);

  if (!suppliedKey || !constantTimeEquals(suppliedKey, expectedKey)) {
    return res.status(401).json({
      error: "invalid_launcher_api_key",
      message: "A valid launcher API key is required.",
    });
  }

  return next();
}

const launcherRouters = [launcherRouter, shopRouter, leaderboardRouter];
app.get("/auth/callback", launcherCors, launcherDiscordCallback);
app.get("/auth/launcher/callback", launcherCors, launcherDiscordCallback);
app.use("/api/launcher", launcherCors, requireLauncherApiKey, ...launcherRouters);
app.use("/launcher", launcherCors, requireLauncherApiKey, ...launcherRouters);

async function importRoutes(relativeDirectory) {
  const directory = path.join(__dirname, relativeDirectory);
  for (const fileName of fs.readdirSync(directory).sort()) {
    if (!fileName.endsWith(".js")) continue;
    try {
      const module = await import(pathToFileURL(path.join(directory, fileName)).href);
      if (module.default) app.use(module.default);
      else log.warn(`Route module ${fileName} has no default export.`);
    } catch (error) {
      log.error(`Failed to load route ${fileName}: ${error.stack || error.message}`);
      if (envBoolean("FAIL_ON_ROUTE_LOAD_ERROR", true)) throw error;
    }
  }
}

await importRoutes("Routes");

app.use((req, res) => {
  log.debug(`Missing endpoint: ${req.method} ${req.originalUrl}`);
  return Utils.createError(
    "errors.com.epicgames.common.not_found",
    "Sorry the resource you were trying to find could not be found",
    [],
    1004,
    "not_found",
    404,
    res
  );
});

app.use((error, _req, res, _next) => {
  log.error(`Unhandled HTTP error: ${error.stack || error.message}`);
  if (res.headersSent) return;
  return res.status(500).json({ error: "internal_server_error" });
});

mongoose.set("strictQuery", true);
await mongoose.connect(envString("MONGO_URI"), {
  serverSelectionTimeoutMS: envInteger("MONGO_TIMEOUT_MS", 10000, { min: 1000, max: 60000 }),
});
log.database("Connected to MongoDB");

if (envBoolean("DISCORD_BOT_ENABLED", true)) {
  try {
    const { client } = await import("./discord/index.js");
    await client.login(envString("BOT_TOKEN"));
  } catch (error) {
    log.error(`Discord bot startup failed: ${error.stack || error.message}`);
    if (envBoolean("DISCORD_BOT_REQUIRED", false)) throw error;
  }
}

if (envBoolean("MATCHMAKER_ENABLED", true)) {
  await import("./matchmaker/src/matchmaker.js").catch((error) => {
    log.error(`Matchmaker startup failed: ${error.stack || error.message}`);
    if (envBoolean("MATCHMAKER_REQUIRED", false)) throw error;
  });
}

const server = app.listen(port, envString("HTTP_HOST", "0.0.0.0"), async () => {
  log.backendstart(`Backend started on ${envString("HTTP_HOST", "0.0.0.0")}:${port}`);
  if (envBoolean("XMPP_ENABLED", true)) {
    await import("./xmpp/xmpp.js").catch((error) => {
      log.error(`XMPP startup failed: ${error.stack || error.message}`);
      if (envBoolean("XMPP_REQUIRED", false)) process.exitCode = 1;
    });
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    log.error(`Port ${port} is already in use.`);
  } else {
    log.error(`HTTP server error: ${error.stack || error.message}`);
  }
  process.exitCode = 1;
});

async function shutdown(signal) {
  log.warn(`Received ${signal}; shutting down.`);
  server.close();
  await Promise.allSettled([
    mongoose.disconnect(),
    global.discordClient?.destroy?.(),
    Utils.UpdateTokens(),
  ]);
  process.exit(0);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
