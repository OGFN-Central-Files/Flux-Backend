import express from "express";
const app = express.Router();
import path from "path";
import fs from "fs";
import { dirname } from "dirname-filename-esm";
const __dirname = dirname(import.meta);
const eventsPath = path.join(__dirname, "../local/events/Events.json");

function readSafeEvents() {
  try {
    if (!fs.existsSync(eventsPath)) {
      return { events: [], templates: {}, scoringRules: {}, player: { tokens: [], persistentScores: {} } };
    }

    const raw = fs
      .readFileSync(eventsPath, "utf8")
      .replace(/skunkyskunkyhype/g, "0")
      .replace(/skunkyskunkyseason/g, "S1")
      .replace(/skunkyskunkyaccountid/g, "unknown")
      .replace(/skunkyskunkydivision/g, "");
    const parsed = JSON.parse(raw);

    return {
      events: Array.isArray(parsed.events) ? parsed.events : [],
      templates: parsed.templates && typeof parsed.templates === "object" ? parsed.templates : {},
      scoringRules: parsed.scoringRules && typeof parsed.scoringRules === "object" ? parsed.scoringRules : {},
      player: parsed.player && typeof parsed.player === "object"
        ? parsed.player
        : { tokens: [], persistentScores: {} },
    };
  } catch {
    return { events: [], templates: {}, scoringRules: {}, player: { tokens: [], persistentScores: {} } };
  }
}

app.post("/fortnite/api/game/v2/chat/*/*/*/pc", (req, res) => {
  let resp = { GlobalChatRooms: [{ roomName: "Fluxglobal" }] };
  res.json(resp);
});
app.post("/fortnite/api/game/v2/tryPlayOnPlatform/account/*", (req, res) => {
  res.setHeader("Content-Type", "text/plain");
  res.send(true);
});
app.get("/launcher/api/public/distributionpoints/", (req, res) => {
  res.json({
    distributions: [
      "https://download.epicgames.com/",
      "https://download2.epicgames.com/",
      "https://download3.epicgames.com/",
      "https://download4.epicgames.com/",
      "https://epicgames-download1.akamaized.net/",
    ],
  });
});
app.get("/launcher/api/public/assets/*", async (req, res) => {
  res.json({
    appName: "FortniteContentBuilds",
    labelName: "Flux",
    buildVersion: "++Fortnite+Release-20.00-CL-19458861-Windows",
    catalogItemId: "5cb97847cee34581afdbc445400e2f77",
    expires: "9999-12-31T23:59:59.999Z",
    items: {
      MANIFEST: {
        signature: "Flux",
        distribution: "https://Flux.ol.epicgames.com/",
        path: "Builds/Fortnite/Content/CloudDir/Flux.manifest",
        hash: "55bb954f5596cadbe03693e1c06ca73368d427f3",
        additionalDistributions: [],
      },
      CHUNKS: {
        signature: "Flux",
        distribution: "https://Flux.ol.epicgames.com/",
        path: "Builds/Fortnite/Content/CloudDir/Flux.manifest",
        additionalDistributions: [],
      },
    },
    assetId: "FortniteContentBuilds",
  });
});
app.get("/Builds/Fortnite/Content/CloudDir/*.manifest", async (req, res) => {
  res.set("Content-Type", "application/octet-stream");
  const manifest = fs.readFileSync(
    path.join(
      __dirname,
      "../",
      "CloudDir",
      "Flux.manifest"
    )
  );
  res.status(200).send(manifest).end();
});
app.get("/Builds/Fortnite/Content/CloudDir/*.chunk", async (req, res) => {
  res.set("Content-Type", "application/octet-stream");
  const chunk = fs.readFileSync(
    path.join(__dirname, "../", "CloudDir", "Flux.chunk")
  );
  res.status(200).send(chunk).end();
});
app.get("/Builds/Fortnite/Content/CloudDir/*.ini", async (req, res) => {
  const ini = fs.readFileSync(
    path.join(__dirname, "../../", "CloudDir", "Full.ini")
  );
  res.status(200).send(ini).end();
});
app.get("/waitingroom/api/waitingroom", (req, res) => {
  res.status(204);
  res.end();
});
app.get("/socialban/api/public/v1/*", (req, res) => {
  res.json({
    bans: [],
    warnings: [],
  });
});
app.get(
  "/fortnite/api/game/v2/events/tournamentandhistory/*/*",
  (req, res) => {
    const events = readSafeEvents();
    const history = {};
    for (const event of events.events) {
      if (!event?.eventId) continue;
      const windows = Array.isArray(event.eventWindows) ? event.eventWindows : [];
      const rows = windows.map((window) => ({
        eventId: event.eventId,
        eventWindowId: window.eventWindowId || "",
        eventTemplateId: window.eventTemplateId || "",
        teamAccountIds: [],
        pointsEarned: 0,
        score: 0,
        rank: 0,
        percentile: 0,
        beginTime: window.beginTime || "2020-01-01T00:00:00.000Z",
        endTime: window.endTime || "9999-12-31T23:59:59.000Z",
        sessionHistory: [],
      }));
      history[event.eventId] = {
        events: rows,
        paging: { count: rows.length, total: rows.length },
      };
    }
    res.json({
      events: events.events,
      templates: events.templates,
      scoringRules: events.scoringRules,
      player: events.player,
      history,
      tournamentAndHistory: true,
      serverTime: new Date().toISOString(),
    });
  }
);
app.get("/fortnite/api/statsv2/account/:accountId", (req, res) => {
  res.json({
    startTime: 0,
    endTime: 0,
    stats: {},
    accountId: req.params.accountId,
  });
});
app.get("/statsproxy/api/statsv2/account/:accountId", (req, res) => {
  res.json({
    startTime: 0,
    endTime: 0,
    stats: {},
    accountId: req.params.accountId,
  });
});
app.get(
  "/fortnite/api/stats/accountId/:accountId/bulk/window/alltime",
  (req, res) => {
    res.json({
      startTime: 0,
      endTime: 0,
      stats: {},
      accountId: req.params.accountId,
    });
  }
);
app.post("/fortnite/api/feedback/*", (req, res) => {
  res.status(200);
  res.end();
});
app.post("/fortnite/api/statsv2/query", (req, res) => {
  res.json([]);
});
app.post("/statsproxy/api/statsv2/query", (req, res) => {
  res.json([]);
});
app.post("/fortnite/api/game/v2/events/v2/setSubgroup/*", (req, res) => {
  res.status(204);
  res.end();
});
app.get("/fortnite/api/game/v2/enabled_features", (req, res) => {
  res.json([]);
});

app.post(
  "/api/v1/assets/Fortnite/*/*",
  async (req, res) => {
    /*if (req.body.hasOwnProperty("FortCreativeDiscoverySurface") && req.body.FortCreativeDiscoverySurface == 0) {
        const discovery_api_assets = require("../../responses/Athena/Discovery/discovery_api_assets.json");
        res.json(discovery_api_assets)
    }
    else {*/
    res.json({
      FortCreativeDiscoverySurface: {
        meta: {
          promotion: req.body.FortCreativeDiscoverySurface || 0,
        },
        assets: {},
      },
    });
  }
  /*}*/
);
app.get("/fortnite/api/game/v2/twitch/*", (req, res) => {
  res.status(200);
  res.end();
});
app.get("/fortnite/api/game/v2/world/info", (req, res) => {
  res.json({});
});
app.post(
  "/fortnite/api/game/v2/chat/*/recommendGeneralChatRooms/pc",
  (req, res) => {
    res.json({});
  }
);
app.get("/fortnite/api/receipts/v1/account/*/receipts", (req, res) => {
  res.json([]);
});
app.get("/fortnite/api/game/v2/leaderboards/cohort/*", (req, res) => {
  res.json([]);
});
app.post("/datarouter/api/v1/public/data", (req, res) => {
  res.status(204);
  res.end();
});
app.post("/api/v1/user/setting", async (req, res) => {
  res.json([]);
})
export default app;
//# sourceMappingURL=main.js.map
