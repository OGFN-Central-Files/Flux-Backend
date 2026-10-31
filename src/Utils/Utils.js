import axios from "axios";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import XMLBuilder from "xmlbuilder";
import User from "../User/Mongodb/Schema/user.js";
import Profile from "../User/Mongodb/Schema/profiles.js";
import Friends from "../User/Mongodb/Schema/friends.js";
import profileManager from "../User/profile.js";
import log from "./log.js";
import { applyConfiguredShop } from "./catalogConfig.js";
import { v4 } from "uuid";
import jwt from "jsonwebtoken";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { envInteger, envString } from "../Config/env.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();

export default class Utils {
  static createError(
    errorCode,
    errorMessage,
    messageVars,
    numericErrorCode,
    error,
    statusCode,
    res
  ) {
    log.error(`API Error ${numericErrorCode} - ${errorCode}: ${errorMessage}`);
    res.set({
      "X-Epic-Error-Name": errorCode,
      "X-Epic-Error-Code": numericErrorCode,
    });
    res.status(statusCode).json({
      errorCode,
      errorMessage,
      messageVars,
      numericErrorCode,
      originatingService: "any",
      intent: "prod",
      error_description: errorMessage,
      error,
    });
  }

  static async SendEmptyGift(username, accountId) {
    log.info(`Sending empty gift notification to ${username} (${accountId})`);
    try {
      await axios.post(
        `http://127.0.0.1:${envInteger("PORT", 3551, { min: 1, max: 65535 })}/fortnite/api/game/v3/profile/*/client/emptygift`,
        {
          offerId: "e406693aa12adbc8b04ba7e6409c8ab3d598e8c3",
          currency: "MtxCurrency",
          currencySubType: "",
          expectedTotalPrice: "0",
          gameContext: "",
          receiverAccountIds: [accountId],
          giftWrapTemplateId: "GiftBox:gb_makegood",
          personalMessage: "",
          accountId,
          playerName: username,
        },
        { timeout: 5000 }
      );
      return true;
    } catch (err) {
      log.warn(`Empty gift notification failed for ${username}: ${err.message}`);
      return false;
    }
  }

  static async FetchApplication() {
    log.request("Fetching Discord application info");
    const req = await fetch("https://discord.com/api/v10/applications/@me", {
      method: "GET",
      headers: {
        Authorization: `Bot ${process.env.BOT_TOKEN}`,
      },
    });
    const res = await req.json();
    log.info("Discord application info fetched successfully");
    return res;
  }

  static DecodeBase64(str) {
    return Buffer.from(str, "base64").toString();
  }

  static async CreateUser(discordId, username, email, plainPassword, isServer = false) {
    const normalizedDiscordId = String(discordId || "").trim();
    const normalizedUsername = String(username || "").trim();
    const normalizedEmail = String(email || "").trim().toLowerCase();
    const password = String(plainPassword || "");
    const minPasswordLength = envInteger("ACCOUNT_PASSWORD_MIN_LENGTH", 8, { min: 8, max: 64 });
    const maxUsernameLength = envInteger("ACCOUNT_USERNAME_MAX_LENGTH", 24, { min: 3, max: 32 });
    const bcryptRounds = envInteger("BCRYPT_ROUNDS", 10, { min: 8, max: 14 });

    log.request(
      `User creation request: ${normalizedUsername} (Discord: ${normalizedDiscordId})`
    );

    if (!normalizedDiscordId || !normalizedUsername || !normalizedEmail || !password) {
      return { message: "Discord ID, username, email, and password are required.", status: 400 };
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return { message: "A valid email address is required.", status: 400 };
    }

    if (normalizedUsername.length < 3 || normalizedUsername.length > maxUsernameLength) {
      return {
        message: `Username must be between 3 and ${maxUsernameLength} characters.`,
        status: 400,
      };
    }

    if (!/^[a-zA-Z0-9 _.-]+$/.test(normalizedUsername)) {
      return {
        message: "Username may only contain letters, numbers, spaces, underscores, periods, and hyphens.",
        status: 400,
      };
    }

    if (password.length < minPasswordLength || password.length > 127) {
      return {
        message: `Password must be between ${minPasswordLength} and 127 characters.`,
        status: 400,
      };
    }

    const duplicate = await User.findOne({
      $or: [
        { discordId: normalizedDiscordId },
        { username_lower: normalizedUsername.toLowerCase() },
        { email: normalizedEmail },
      ],
    }).lean();

    if (duplicate) {
      if (duplicate.discordId === normalizedDiscordId) {
        return { message: "You already created an account!", status: 409 };
      }
      return { message: "Username or email is already in use.", status: 409 };
    }

    const accountId = v4().replace(/-/g, "");
    const created = new Date();
    const hashedPassword = await bcrypt.hash(password, bcryptRounds);
    let userCreated = false;

    try {
      const user = await User.create({
        created,
        banned: false,
        discordId: normalizedDiscordId,
        accountId,
        username: normalizedUsername,
        username_lower: normalizedUsername.toLowerCase(),
        email: normalizedEmail,
        password: hashedPassword,
        isServer: Boolean(isServer),
        matchmakingId: v4(),
      });
      userCreated = true;

      await Profile.create({
        created,
        accountId,
        profiles: await profileManager.createProfiles(accountId),
      });

      await Friends.create({
        created,
        accountId,
      });

      log.info(`Account registration completed: ${normalizedUsername} (${accountId})`);
      return {
        message: `Successfully created an account with the username ${normalizedUsername}`,
        status: 201,
        user: {
          accountId: user.accountId,
          discordId: user.discordId,
          username: user.username,
          email: user.email,
          created: user.created,
        },
      };
    } catch (err) {
      if (userCreated) {
        await Promise.allSettled([
          User.deleteOne({ accountId }),
          Profile.deleteOne({ accountId }),
          Friends.deleteOne({ accountId }),
        ]);
      }

      if (err?.code === 11000) {
        log.warn(`Duplicate registration attempt for username ${normalizedUsername}`);
        return { message: "Username or email is already in use.", status: 409 };
      }

      log.error(`User creation failed: ${err.message}`);
      return {
        message: "Account creation failed. No account data was kept.",
        status: 500,
      };
    }
  }

  static async DeleteAccountData(accountId) {
    if (!accountId) return false;
    await Utils.RevokeAccountSessions(accountId);

    const results = await Promise.allSettled([
      User.deleteOne({ accountId }),
      Profile.deleteOne({ accountId }),
      Friends.deleteOne({ accountId }),
    ]);
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      for (const failure of failures) {
        log.error(`Account data deletion failed for ${accountId}: ${failure.reason?.message || failure.reason}`);
      }
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        `Unable to delete all account data for ${accountId}`
      );
    }
    return true;
  }

  static async RevokeAccountSessions(accountId) {
    if (!accountId) return;

    await User.updateOne({ accountId }, { $inc: { launcherTokenVersion: 1 } }).catch((error) => {
      log.warn(`Failed to invalidate launcher sessions for ${accountId}: ${error.message}`);
    });

    const beforeAccess = Array.isArray(global.accessTokens) ? global.accessTokens.length : 0;
    const beforeRefresh = Array.isArray(global.refreshTokens) ? global.refreshTokens.length : 0;

    if (Array.isArray(global.accessTokens)) {
      global.accessTokens = global.accessTokens.filter((token) => token.accountId !== accountId);
    }
    if (Array.isArray(global.refreshTokens)) {
      global.refreshTokens = global.refreshTokens.filter((token) => token.accountId !== accountId);
    }

    const xmppClient = Array.isArray(global.Clients)
      ? global.Clients.find((entry) => entry.accountId === accountId)
      : null;
    try {
      xmppClient?.client?.close();
    } catch (error) {
      log.warn(`Failed to close XMPP session for ${accountId}: ${error.message}`);
    }

    if (
      beforeAccess !== (global.accessTokens?.length || 0) ||
      beforeRefresh !== (global.refreshTokens?.length || 0)
    ) {
      await Utils.UpdateTokens();
    }
  }

  static GetXMPPStatus(fromId, toId, offline) {
    if (!global.Clients) return;

    const SenderData = global.Clients.find((i) => i.accountId === fromId);
    const ClientData = global.Clients.find((i) => i.accountId === toId);
    if (!SenderData || !ClientData) return;

    log.xmpp(
      `${offline ? "Offline" : "Online"} presence → ${toId} (from ${fromId})`
    );

    let xml = XMLBuilder.create("presence")
      .attribute("to", ClientData.jid)
      .attribute("xmlns", "jabber:client")
      .attribute("from", SenderData.jid)
      .attribute("type", offline ? "unavailable" : "available");

    if (SenderData.lastPresenceUpdate.away)
      xml = xml
        .element("show", "away")
        .up()
        .element("status", SenderData.lastPresenceUpdate.status)
        .up();
    else xml = xml.element("status", SenderData.lastPresenceUpdate.status).up();

    ClientData.client.send(xml.toString());
  }

  static SendXMPPMessage(body, toAccountId) {
    if (!global.Clients) return;
    if (typeof body === "object") body = JSON.stringify(body);

    const receiver = global.Clients.find((i) => i.accountId === toAccountId);
    if (!receiver) return;

    log.xmpp(
      `Message → ${toAccountId}: ${body.substring(0, 150)}${
        body.length > 150 ? "..." : ""
      }`
    );

    receiver.client.send(
      XMLBuilder.create("message")
        .attribute("from", "xmpp-admin@prod.ol.epicgames.com")
        .attribute("to", receiver.jid)
        .attribute("xmlns", "jabber:client")
        .element("body", `${body}`)
        .up()
        .toString()
    );
  }

  static GetVersion(req) {
    const memory = { season: 0, build: 0.0, CL: "0", lobby: "LobbySeason0" };
    const ua = (req.headers["user-agent"] || "").trim();

    if (!ua || !ua.includes("Fortnite")) {
      return memory;
    }

    let detected = false;

    const modernMatch = ua.match(/Release-([0-9]+)\.([0-9]+)(?:-CL-([0-9]+))?/);
    if (modernMatch) {
      const major = parseInt(modernMatch[1], 10);
      const minor = parseInt(modernMatch[2], 10);
      const cl = modernMatch[3] || "0";

      memory.season = major;
      memory.build = Number(`${major}.${minor}`);
      memory.CL = cl;
      memory.lobby = `LobbySeason${major}`;

      return memory;
    }

    let cl = "0";
    try {
      const clMatch = ua.match(/-CL-?([0-9]+)/i) || ua.match(/([0-9]{7,})/);
      if (clMatch) cl = clMatch[1];
    } catch {}

    try {
      const legacyBuild = ua.split("Release-")[1]?.split("-")[0];
      if (legacyBuild && /^\d+\.\d+$/.test(legacyBuild)) {
        const [a, b] = legacyBuild.split(".");
        const season = parseInt(a, 10);
        memory.season = season;
        memory.build = Number(`${a}.${b.padEnd(2, "0")}`);
        memory.CL = cl;
        memory.lobby =
          season <= 1 ? `LobbySeason${season}` : "LobbyWinterDecor";
        return memory;
      }
    } catch {}

    const nCL = parseInt(cl, 10);
    if (!isNaN(nCL) && nCL > 0) {
      if (nCL <= 3790078) {
        const season = nCL < 3724489 ? 0 : 1;
        Object.assign(memory, {
          season,
          build: season === 0 ? 0.0 : 1.0,
          CL: cl,
          lobby: season === 0 ? "LobbySeason0" : "LobbySeason1",
        });
      } else {
        Object.assign(memory, {
          season: 2,
          build: 2.0,
          CL: cl,
          lobby: "LobbyWinterDecor",
        });
      }
      return memory;
    }

    return memory;
  }

  static createClient(clientId, grant_type, ip, expiresIn) {
    const token = `eg1~${jwt.sign(
      {
        p: Buffer.from(v4()).toString("base64"),
        clsvc: "fortnite",
        t: "s",
        mver: false,
        clid: clientId,
        ic: true,
        am: grant_type,
        jti: v4().replace(/-/gi, ""),
        creation_date: new Date(),
        hours_expire: expiresIn,
      },
      global.JWT_SECRET,
      { expiresIn: `${expiresIn}h` }
    )}`;

    global.clientTokens.push({ ip, token });
    log.info(`Client token issued for IP ${ip} (${grant_type})`);
    return token;
  }

  static createAccess(user, clientId, grant_type, deviceId, expiresIn) {
    if (!user?.accountId) throw new Error("Invalid user: missing accountTo");

    const token = `eg1~${jwt.sign(
      {
        app: "fortnite",
        sub: user.accountId,
        dvid: deviceId,
        mver: false,
        clid: clientId,
        dn: user.username || "Unknown",
        am: grant_type,
        p: Buffer.from(v4()).toString("base64"),
        iai: user.accountId,
        sec: 1,
        clsvc: "fortnite",
        t: "s",
        ic: true,
        jti: v4().replace(/-/gi, ""),
        creation_date: new Date().toISOString(),
        hours_expire: expiresIn,
      },
      global.JWT_SECRET,
      { expiresIn: `${expiresIn}h` }
    )}`;

    global.accessTokens.push({ accountId: user.accountId, token });
    log.info(
      `Access token created for ${user.username} (${user.accountId}) - ${grant_type}`
    );
    return token;
  }

  static createRefresh(user, clientId, grant_type, deviceId, expiresIn) {
    const token = `eg1~${jwt.sign(
      {
        sub: user.accountId,
        dvid: deviceId,
        t: "r",
        clid: clientId,
        am: grant_type,
        jti: v4().replace(/-/gi, ""),
        creation_date: new Date(),
        hours_expire: expiresIn,
      },
      global.JWT_SECRET,
      { expiresIn: `${expiresIn}h` }
    )}`;

    global.refreshTokens.push({ accountId: user.accountId, token });
    log.info(`Refresh token created for ${user.username} (${user.accountId})`);
    return token;
  }

  static getOfferID(offerId) {
    const catalog = applyConfiguredShop(JSON.parse(
      fs.readFileSync(
        path.join(__dirname, "../local/Storefront/Catalog.json"),
        "utf8"
      )
    ));

    for (const storefront of catalog.storefronts) {
      const entry = storefront.catalogEntries.find(
        (i) => i.offerId === offerId
      );
      if (entry) {
        log.info(`OfferID resolved: ${offerId} → ${storefront.name}`);
        return { name: storefront.name, offerId: entry };
      }
    }

    return null;
  }

  static async UpdateTokens() {
    const payload = JSON.stringify(
      {
        accessTokens: Array.isArray(global.accessTokens) ? global.accessTokens : [],
        refreshTokens: Array.isArray(global.refreshTokens) ? global.refreshTokens : [],
        clientTokens: Array.isArray(global.clientTokens) ? global.clientTokens : [],
      },
      null,
      2
    );

    try {
      if (global.kv?.set) await global.kv.set("tokens", payload);
      const configuredPath = envString("TOKEN_STORE_PATH", "tokens.json");
      const tokenPath = path.isAbsolute(configuredPath)
        ? configuredPath
        : path.join(process.cwd(), configuredPath);
      await fs.promises.writeFile(tokenPath, payload, "utf8");
      log.debug(`Token storage updated: ${tokenPath}`);
    } catch (err) {
      log.error(`Failed to persist tokens: ${err.message}`);
    }
  }
}
