import crypto from "node:crypto";
import express from "express";
import mongoose from "mongoose";
import { fileURLToPath } from "node:url";
import { envBoolean, envInteger, envString, requireEnvironment } from "../../Config/env.js";
import log from "../../Utils/log.js";

export function isDirectRun(importMetaUrl) {
  return Boolean(process.argv[1] && fileURLToPath(importMetaUrl) === process.argv[1]);
}

export function createJsonServiceApp(serviceName) {
  const app = express();
  app.disable("x-powered-by");
  if (envBoolean("TRUST_PROXY", false)) app.set("trust proxy", 1);
  app.use(express.json({ limit: envString("HTTP_BODY_LIMIT", "1mb") }));
  app.get("/health", (_req, res) => res.json({ status: "ok", service: serviceName }));
  return app;
}

export function configuredRewardsApiKey() {
  return envString("REWARDS_API_KEY", envString("API_KEY"));
}

function keysMatch(expected, provided) {
  if (!expected || !provided) return false;
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  return (
    expectedBuffer.length === providedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, providedBuffer)
  );
}

export function privateApiMiddleware({
  key = configuredRewardsApiKey(),
  required = envBoolean("REWARDS_API_REQUIRE_KEY", true),
  serviceName = "private-api",
} = {}) {
  if (required && !key) {
    throw new Error(`${serviceName} requires REWARDS_API_KEY or API_KEY`);
  }

  return (req, res, next) => {
    if (!required) return next();
    if (!keysMatch(key, req.get("x-api-key"))) {
      log.warn(`Rejected ${serviceName} request from ${req.ip}`);
      return res.status(401).json({ error: "unauthorized" });
    }
    return next();
  };
}

export async function connectServiceMongo(serviceName) {
  requireEnvironment(["MONGO_URI"]);
  if (mongoose.connection.readyState === 1) return;
  mongoose.set("strictQuery", true);
  await mongoose.connect(envString("MONGO_URI"), {
    serverSelectionTimeoutMS: envInteger("MONGO_TIMEOUT_MS", 10000, {
      min: 1000,
      max: 120000,
    }),
  });
  log.database(`Connected to MongoDB for ${serviceName}`);
}

export function listenService(app, { port, serviceName }) {
  return app.listen(port, envString("HTTP_HOST", "0.0.0.0"), () => {
    log.api(`${serviceName} listening on port ${port}`);
  });
}

export function installServiceNotFound(app) {
  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
}
