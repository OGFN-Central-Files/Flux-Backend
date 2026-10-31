import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "dirname-filename-esm";
import { REST, Routes } from "discord.js";
import { envString } from "../Config/env.js";
import log from "../Utils/log.js";

const __dirname = dirname(import.meta);

async function collectCommands() {
  const commands = [];
  const foldersPath = path.join(__dirname, "commands");

  for (const folder of fs.readdirSync(foldersPath, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    const commandsPath = path.join(foldersPath, folder.name);

    for (const file of fs.readdirSync(commandsPath)) {
      if (!file.endsWith(".js")) continue;
      const command = await import(pathToFileURL(path.join(commandsPath, file)).href);
      if (!command.data?.toJSON || typeof command.execute !== "function") {
        log.warn(`Skipping invalid Discord command module: ${folder.name}/${file}`);
        continue;
      }
      commands.push(command.data.toJSON());
    }
  }

  return commands;
}

export async function deployCommands(applicationId) {
  const token = envString("BOT_TOKEN");
  if (!token || !applicationId) {
    log.warn("Discord commands were not deployed because BOT_TOKEN or application ID is missing.");
    return [];
  }

  const commands = await collectCommands();
  const scope = envString("DISCORD_COMMAND_SCOPE", "guild").toLowerCase();
  const guildId = envString("GUILD_ID");
  const rest = new REST({ version: "10" }).setToken(token);

  let route;
  if (scope === "global") {
    route = Routes.applicationCommands(applicationId);
  } else {
    if (!guildId) {
      throw new Error("GUILD_ID is required when DISCORD_COMMAND_SCOPE=guild");
    }
    route = Routes.applicationGuildCommands(applicationId, guildId);
  }

  const deployed = await rest.put(route, { body: commands });
  log.bot(`Deployed ${deployed.length} Discord commands to ${scope} scope.`);
  return deployed;
}


const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  const applicationId = envString("CLIENT_ID");
  if (!applicationId) {
    log.error("CLIENT_ID is required to deploy Discord commands manually.");
    process.exitCode = 1;
  } else {
    deployCommands(applicationId).catch((error) => {
      log.error(`Discord command deployment failed: ${error.stack || error.message}`);
      process.exitCode = 1;
    });
  }
}
