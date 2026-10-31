import "dotenv/config";
import { envBoolean, envInteger, envList, envString } from "../src/Config/env.js";
import { normalizeMatchmakerUrl, parseGameServerAddress } from "../src/matchmaker/src/protocol.js";

const errors = [];
const warnings = [];

function requireValue(name, when = true) {
  if (when && !envString(name)) errors.push(`${name} is required.`);
}

requireValue("MONGO_URI");
requireValue("BOT_TOKEN", envBoolean("DISCORD_BOT_ENABLED", true));
requireValue("CLIENT_ID", envBoolean("DISCORD_BOT_ENABLED", true));
requireValue("GUILD_ID", envBoolean("DISCORD_BOT_ENABLED", true) && envString("DISCORD_COMMAND_SCOPE", "global") === "guild");

const gameSecret = envString("GAME_JWT_SECRET");
const launcherSecret = envString("LAUNCHER_JWT_SECRET");
const launcherApiKey = envString("LAUNCHER_API_KEY");
if (!gameSecret) warnings.push("GAME_JWT_SECRET is empty; sessions will stop working after every restart.");
else if (gameSecret.length < 32) warnings.push("GAME_JWT_SECRET should be at least 32 characters.");
if (!launcherSecret) warnings.push("LAUNCHER_JWT_SECRET is empty; launcher login cannot be used safely.");
else if (launcherSecret.length < 32) warnings.push("LAUNCHER_JWT_SECRET should be at least 32 characters.");
if (gameSecret && launcherSecret && gameSecret === launcherSecret) warnings.push("Use different GAME_JWT_SECRET and LAUNCHER_JWT_SECRET values.");
if (envBoolean("LAUNCHER_API_KEY_REQUIRED", Boolean(launcherApiKey)) && !launcherApiKey) {
  errors.push("LAUNCHER_API_KEY is required when LAUNCHER_API_KEY_REQUIRED=true.");
} else if (launcherApiKey && launcherApiKey.length < 24) {
  warnings.push("LAUNCHER_API_KEY should be at least 24 characters.");
}

try {
  normalizeMatchmakerUrl(
    envString("MATCHMAKER_PUBLIC_URL", envString("MATCHMAKER_IP", "127.0.0.1")),
    envInteger("MATCHMAKER_WS_PORT", 81)
  );
} catch {
  errors.push("MATCHMAKER_PUBLIC_URL is invalid. Example: ws://127.0.0.1:81");
}

const regions = envList("MATCHMAKER_SUPPORTED_REGIONS", ["NAE", "EU"]).map((region) => region.toUpperCase());
for (const region of regions) {
  const value = envString(`GAME_SERVER_${region}`, envString(`${region}_IP`));
  if (!parseGameServerAddress(value, envInteger("GAME_SERVER_DEFAULT_PORT", 7777))) {
    errors.push(`GAME_SERVER_${region} (or ${region}_IP) must be host:port.`);
  }
}

const ports = {
  PORT: envInteger("PORT", 3551),
  XMPP_PORT: envInteger("XMPP_PORT", 70),
  MATCHMAKER_WS_PORT: envInteger("MATCHMAKER_WS_PORT", 81),
  MATCHMAKER_HTTP_PORT: envInteger("MATCHMAKER_HTTP_PORT", 82),
};
const seen = new Map();
for (const [name, port] of Object.entries(ports)) {
  if (seen.has(port)) errors.push(`${name} conflicts with ${seen.get(port)} on port ${port}.`);
  else seen.set(port, name);
}

console.log("Flux check");
console.log(`- Regions: ${regions.join(", ")}`);
console.log(`- Backend port: ${ports.PORT}`);
console.log(`- XMPP port: ${ports.XMPP_PORT}`);
console.log(`- Matchmaker ports: ${ports.MATCHMAKER_WS_PORT}/${ports.MATCHMAKER_HTTP_PORT}`);

for (const warning of warnings) console.warn(`WARNING: ${warning}`);
for (const error of errors) console.error(`ERROR: ${error}`);

if (errors.length) process.exitCode = 1;
else console.log("Configuration looks valid.");
