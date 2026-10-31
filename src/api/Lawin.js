import "dotenv/config";
import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import User from "../User/Mongodb/Schema/user.js";
import log from "../Utils/log.js";
import { envBoolean, envInteger, envList, envString } from "../Config/env.js";

const app = express();
const port = envInteger("LAWIN_API_PORT", 94, { min: 1, max: 65535 });
const requireKey = envBoolean("LAWIN_API_REQUIRE_KEY", false);
const apiKey = envString("LAWIN_API_KEY", envString("API_KEY"));
const allowedOrigins = envList("LAWIN_ALLOWED_ORIGINS");

app.disable("x-powered-by");
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Origin not allowed"));
    },
  })
);
app.use(express.json({ limit: "64kb" }));

app.get("/api/v1/checkUser/:username", async (req, res) => {
  if (requireKey && (!apiKey || req.get("x-api-key") !== apiKey)) {
    return res.status(401).send("Unauthorized");
  }

  try {
    const username = String(req.params.username || "").trim().toLowerCase();
    if (!username || username.length > 32) return res.status(400).send("Invalid");

    const user = await User.exists({ username_lower: username, banned: { $ne: true } });
    return user ? res.status(200).send("Valid") : res.status(404).send("Invalid");
  } catch (error) {
    log.error(`Lawin user check failed: ${error.message}`);
    return res.status(500).send("Server Error");
  }
});

await mongoose.connect(envString("MONGO_URI"), {
  serverSelectionTimeoutMS: envInteger("MONGO_TIMEOUT_MS", 10000, { min: 1000, max: 60000 }),
});

app.listen(port, envString("HTTP_HOST", "0.0.0.0"), () => {
  log.api(`Lawin server running on port ${port}`);
});
