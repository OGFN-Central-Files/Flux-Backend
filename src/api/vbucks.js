import "dotenv/config";
import User from "../User/Mongodb/Schema/user.js";
import Profile from "../User/Mongodb/Schema/profiles.js";
import Utils from "../Utils/Utils.js";
import log from "../Utils/log.js";
import { envBoolean, envInteger } from "../Config/env.js";
import {
  connectServiceMongo,
  createJsonServiceApp,
  installServiceNotFound,
  isDirectRun,
  listenService,
  privateApiMiddleware,
} from "./utils/service.js";

const PORT = envInteger("VBUCKS_API_PORT", 92, { min: 1, max: 65535 });
const MAX_AMOUNT = envInteger("VBUCKS_MAX_PER_REQUEST", 200, { min: 1, max: 1000000 });
const ENABLE_LEGACY_GET = envBoolean("REWARDS_ENABLE_LEGACY_GET", true);
const TRACK_MATCH_STATS = envBoolean("VBUCKS_TRACK_MATCH_STATS", true);
const KILL_REWARD_AMOUNT = envInteger("VBUCKS_KILL_REWARD_AMOUNT", 50, { min: 1, max: 1000000 });
const WIN_REWARD_AMOUNT = envInteger("VBUCKS_WIN_REWARD_AMOUNT", 200, { min: 1, max: 1000000 });
const app = createJsonServiceApp("vbucks-api");
const authenticate = privateApiMiddleware({ serviceName: "vbucks-api" });

async function addVbucks(req, res) {
  const username = String(req.params.username || "").trim();
  const amount = Number.parseInt(String(req.body?.amount ?? req.params.amount ?? ""), 10);

  if (!username || username.length > 32) {
    return res.status(400).json({ error: "invalid_username" });
  }
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_AMOUNT) {
    return res.status(400).json({
      error: "invalid_amount",
      message: `Amount must be between 1 and ${MAX_AMOUNT}.`,
    });
  }

  try {
    const user = await User.findOne({ username_lower: username.toLowerCase() }).lean();
    if (!user) return res.status(404).json({ error: "user_not_found" });

    const increment = {
      "profiles.common_core.items.Currency:MtxPurchased.quantity": amount,
      "profiles.common_core.rvn": 1,
      "profiles.common_core.commandRevision": 1,
    };

    if (TRACK_MATCH_STATS && amount === KILL_REWARD_AMOUNT) {
      increment["profiles.athena.stats.attributes.lifetime_kills"] = 1;
      increment["profiles.athena.rvn"] = 1;
      increment["profiles.athena.commandRevision"] = 1;
    } else if (TRACK_MATCH_STATS && amount === WIN_REWARD_AMOUNT) {
      increment["profiles.athena.stats.attributes.lifetime_wins"] = 1;
      increment["profiles.athena.rvn"] = 1;
      increment["profiles.athena.commandRevision"] = 1;
    }

    const result = await Profile.updateOne(
      { accountId: user.accountId },
      { $inc: increment }
    );
    if (Number(result.matchedCount ?? result.n ?? 0) !== 1) {
      return res.status(404).json({ error: "profile_not_found" });
    }

    await Utils.SendEmptyGift(username, user.accountId);
    log.vbucks(`Added ${amount} V-Bucks to account ${user.accountId}`);
    return res.json({ success: true, amount });
  } catch (error) {
    log.error(`V-Bucks API request failed: ${error.message}`);
    return res.status(500).json({ error: "internal_server_error" });
  }
}

app.post("/api/v1/rewards/vbucks/:username", authenticate, addVbucks);
if (ENABLE_LEGACY_GET) {
  app.get("/api/v1/rewards/vbucks/:username/:amount", authenticate, addVbucks);
}
installServiceNotFound(app);

export { app };
export async function startVbucksApi() {
  await connectServiceMongo("vbucks-api");
  return listenService(app, { port: PORT, serviceName: "V-Bucks API" });
}

if (isDirectRun(import.meta.url)) {
  startVbucksApi().catch((error) => {
    log.error(`V-Bucks API startup failed: ${error.message}`);
    process.exit(1);
  });
}
