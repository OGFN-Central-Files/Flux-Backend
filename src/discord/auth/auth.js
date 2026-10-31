import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import axios from "axios";
import session from "express-session";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import log from "../../Utils/log.js";
import { envBoolean, envInteger, envString } from "../../Config/env.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = envInteger("DISCORD_AUTH_PORT", 99, { min: 1, max: 65535 });
const sessionSecret = envString("DISCORD_SESSION_SECRET", envString("CLIENT_SECRET"));
const discordApi = "https://discord.com/api/v10";

if (!sessionSecret) throw new Error("DISCORD_SESSION_SECRET or CLIENT_SECRET is required");

app.disable("x-powered-by");
if (envBoolean("TRUST_PROXY", false)) app.set("trust proxy", 1);
app.use(express.json({ limit: "64kb" }));
app.use(
  session({
    name: "flux.sid",
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: envString("NODE_ENV") === "production",
      sameSite: "lax",
      maxAge: envInteger("DISCORD_SESSION_HOURS", 12, { min: 1, max: 168 }) * 3600000,
    },
  })
);
app.use(express.static(path.join(__dirname, "Ui")));

function authorizationUrl(state) {
  const query = new URLSearchParams({
    client_id: envString("CLIENT_ID"),
    redirect_uri: envString("REDIRECT_URI"),
    response_type: "code",
    scope: "identify email",
    state,
  });
  return `https://discord.com/oauth2/authorize?${query}`;
}

app.get("/auth/discord", (req, res) => {
  const state = crypto.randomBytes(24).toString("hex");
  req.session.oauthState = state;
  return req.session.save(() => res.redirect(authorizationUrl(state)));
});

app.get("/auth/discord/callback", async (req, res) => {
  const code = String(req.query.code || "");
  const state = String(req.query.state || "");
  if (!code || !state || state !== req.session.oauthState) {
    return res.status(400).send("Invalid OAuth callback");
  }
  delete req.session.oauthState;

  try {
    const tokenResponse = await axios.post(
      `${discordApi}/oauth2/token`,
      new URLSearchParams({
        client_id: envString("CLIENT_ID"),
        client_secret: envString("CLIENT_SECRET"),
        grant_type: "authorization_code",
        code,
        redirect_uri: envString("REDIRECT_URI"),
      }),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 10000,
      }
    );

    const userResponse = await axios.get(`${discordApi}/users/@me`, {
      headers: { Authorization: `Bearer ${tokenResponse.data.access_token}` },
      timeout: 10000,
    });

    const { id: discordId, username, global_name: globalName, email, avatar, discriminator } = userResponse.data;
    req.session.user = {
      discordId,
      username,
      globalName: globalName || username,
      email,
      avatar,
      discriminator,
    };

    log.discordauth(`Discord OAuth login completed for user ${discordId}`);
    return req.session.save(() => res.redirect("/profile"));
  } catch (error) {
    log.error(`Discord OAuth failed: ${error.response?.status || "network"} ${error.message}`);
    return res.status(500).send("Authentication failed");
  }
});

app.get("/profile", (req, res) => {
  if (!req.session.user) return res.redirect("/auth/discord");
  return res.sendFile(path.join(__dirname, "Ui", "Ui.html"));
});

app.get("/api/user", (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: "unauthorized" });
  return res.json(req.session.user);
});

app.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("flux.sid");
    res.status(204).end();
  });
});

await mongoose.connect(envString("MONGO_URI"), {
  serverSelectionTimeoutMS: envInteger("MONGO_TIMEOUT_MS", 10000, { min: 1000, max: 60000 }),
});

app.listen(port, envString("HTTP_HOST", "0.0.0.0"), () => {
  log.discordauth(`Discord auth server listening on port ${port}`);
});
