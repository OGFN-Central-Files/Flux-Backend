import "dotenv/config";
import User from "../User/Mongodb/Schema/user.js";
import Profile from "../User/Mongodb/Schema/profiles.js";
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

const PORT = envInteger("HYPE_API_PORT", 90, { min: 1, max: 65535 });
const ENABLE_LEGACY_GET = envBoolean("REWARDS_ENABLE_LEGACY_GET", true);
const app = createJsonServiceApp("hype-api");
const authenticate = privateApiMiddleware({ serviceName: "hype-api" });

const REWARD_AMOUNTS = new Map([
  ["elimination", envInteger("HYPE_ELIMINATION_AMOUNT", 20, { min: 0, max: 100000 })],
  ["win", envInteger("HYPE_WIN_AMOUNT", 60, { min: 0, max: 100000 })],
  ["top 3", envInteger("HYPE_TOP3_AMOUNT", 2, { min: 0, max: 100000 })],
  ["top 7", envInteger("HYPE_TOP7_AMOUNT", 4, { min: 0, max: 100000 })],
  ["top 12", envInteger("HYPE_TOP12_AMOUNT", 6, { min: 0, max: 100000 })],
]);

function busFareTiers() {
  const parsed = envString(
    "HYPE_BUS_FARE_TIERS",
    "14000:10,300:8,225:5,175:3,125:1"
  )
    .split(",")
    .map((entry) => entry.split(":").map((part) => Number.parseInt(part.trim(), 10)))
    .filter(([minimum, cost]) => Number.isSafeInteger(minimum) && Number.isSafeInteger(cost) && minimum >= 0 && cost >= 0)
    .sort((a, b) => b[0] - a[0]);

  return parsed.length > 0 ? parsed : [[0, 0]];
}

function hypeDelta(reason, currentHype) {
  const normalized = String(reason || "").trim().toLowerCase();
  if (normalized === "bus fare") {
    const tier = busFareTiers().find(([minimum]) => currentHype >= minimum);
    return { normalized, delta: -(tier?.[1] || 0) };
  }
  if (!REWARD_AMOUNTS.has(normalized)) return null;
  return { normalized, delta: REWARD_AMOUNTS.get(normalized) };
}

async function manageHype(req, res) {
  const username = String(req.params.username || "").trim();
  const reason = req.body?.reason ?? req.params.reason;

  if (!username || username.length > 32) {
    return res.status(400).json({ error: "invalid_username" });
  }

  try {
    const user = await User.findOne({ username_lower: username.toLowerCase() }).lean();
    if (!user) return res.status(404).json({ error: "user_not_found" });

    const profile = await Profile.findOne({ accountId: user.accountId }).lean();
    const currentHype = Number(profile?.profiles?.athena?.stats?.attributes?.arena_hype || 0);
    if (!profile) return res.status(404).json({ error: "profile_not_found" });

    const change = hypeDelta(reason, currentHype);
    if (!change) return res.status(400).json({ error: "invalid_reason" });

    const newHype = Math.max(0, currentHype + change.delta);
    const result = await Profile.updateOne(
      {
        accountId: user.accountId,
        "profiles.athena.stats.attributes.arena_hype": currentHype,
      },
      {
        $set: { "profiles.athena.stats.attributes.arena_hype": newHype },
        $inc: {
          "profiles.athena.rvn": 1,
          "profiles.athena.commandRevision": 1,
        },
      }
    );

    if (Number(result.modifiedCount ?? result.nModified ?? 0) !== 1) {
      return res.status(409).json({ error: "profile_changed", message: "Retry the request." });
    }

    log.hype(`Hype updated for account ${user.accountId}: ${change.delta >= 0 ? "+" : ""}${change.delta}`);
    return res.json({ success: true, reason: change.normalized, delta: change.delta, hype: newHype });
  } catch (error) {
    log.error(`Hype API request failed: ${error.message}`);
    return res.status(500).json({ error: "internal_server_error" });
  }
}

app.post("/api/v1/rewards/managehype/:username", authenticate, manageHype);
if (ENABLE_LEGACY_GET) {
  app.get("/api/v1/rewards/managehype/:username/:reason", authenticate, manageHype);
}
installServiceNotFound(app);

export { app };
export async function startHypeApi() {
  await connectServiceMongo("hype-api");
  return listenService(app, { port: PORT, serviceName: "Hype API" });
}

if (isDirectRun(import.meta.url)) {
  startHypeApi().catch((error) => {
    log.error(`Hype API startup failed: ${error.message}`);
    process.exit(1);
  });
}
