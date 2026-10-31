import "dotenv/config";
import User from "../User/Mongodb/Schema/user.js";
import Profile from "../User/Mongodb/Schema/profiles.js";
import Utils from "../Utils/Utils.js";
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

const PORT = envInteger("UMBRELLA_API_PORT", 93, { min: 1, max: 65535 });
const SEASON = envInteger("MAIN_SEASON", 10, { min: 1, max: 35 });
const ENABLE_LEGACY_GET = envBoolean("REWARDS_ENABLE_LEGACY_GET", true);
const UMBRELLA_ID = envString("UMBRELLA_TEMPLATE_ID", `AthenaGlider:Umbrella_Season_${SEASON}`);
const app = createJsonServiceApp("umbrella-api");
const authenticate = privateApiMiddleware({ serviceName: "umbrella-api" });

async function grantUmbrella(req, res) {
  const username = String(req.params.username || "").trim();
  if (!username || username.length > 32) {
    return res.status(400).json({ error: "invalid_username" });
  }

  try {
    const user = await User.findOne({ username_lower: username.toLowerCase() }).lean();
    if (!user) return res.status(404).json({ error: "user_not_found" });

    const itemPath = `profiles.athena.items.${UMBRELLA_ID}`;
    const result = await Profile.updateOne(
      { accountId: user.accountId, [itemPath]: { $exists: false } },
      {
        $set: {
          [itemPath]: {
            quantity: 1,
            templateId: UMBRELLA_ID,
            attributes: {
              max_level_bonus: 0,
              level: 0,
              item_seen: false,
              xp: 0,
              variants: [],
              favorite: false,
            },
          },
        },
        $inc: {
          "profiles.athena.rvn": 1,
          "profiles.athena.commandRevision": 1,
        },
      }
    );

    if (Number(result.modifiedCount ?? result.nModified ?? 0) !== 1) {
      const profileExists = await Profile.exists({ accountId: user.accountId });
      if (!profileExists) return res.status(404).json({ error: "profile_not_found" });
      return res.json({ success: true, alreadyOwned: true, templateId: UMBRELLA_ID });
    }

    await Utils.SendEmptyGift(username, user.accountId);
    log.umbrella(`Granted ${UMBRELLA_ID} to account ${user.accountId}`);
    return res.json({ success: true, alreadyOwned: false, templateId: UMBRELLA_ID });
  } catch (error) {
    log.error(`Umbrella API request failed: ${error.message}`);
    return res.status(500).json({ error: "internal_server_error" });
  }
}

app.post("/api/v1/rewards/season_umbrella/:username", authenticate, grantUmbrella);
if (ENABLE_LEGACY_GET) {
  app.get("/api/v1/rewards/season_umbrella/:username", authenticate, grantUmbrella);
}
installServiceNotFound(app);

export { app };
export async function startUmbrellaApi() {
  await connectServiceMongo("umbrella-api");
  return listenService(app, { port: PORT, serviceName: "Umbrella API" });
}

if (isDirectRun(import.meta.url)) {
  startUmbrellaApi().catch((error) => {
    log.error(`Umbrella API startup failed: ${error.message}`);
    process.exit(1);
  });
}
