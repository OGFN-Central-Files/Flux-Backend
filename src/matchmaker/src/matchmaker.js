import { WebSocketServer } from "ws";
import http from "node:http";
import crypto from "node:crypto";
import log from "../log/logs.js";
import "dotenv/config";
import { envBoolean, envInteger, envList, envString } from "../../Config/env.js";
import {
  createPlayMessage,
  createStatusUpdate,
  normalizeRegion,
  parseAuthorizationRegion,
  sendIfOpen,
} from "./protocol.js";

const wsPort = envInteger("MATCHMAKER_WS_PORT", 81, { min: 1, max: 65535 });
const httpPort = envInteger("MATCHMAKER_HTTP_PORT", 82, { min: 1, max: 65535 });
const assignmentDelayMs = envInteger("MATCHMAKER_ASSIGNMENT_DELAY_MS", 800, { min: 0, max: 30000 });
const playDelayMs = envInteger("MATCHMAKER_PLAY_DELAY_MS", 2000, { min: 0, max: 30000 });
const joinDelaySec = envInteger("MATCHMAKER_JOIN_DELAY_SECONDS", 1, { min: 0, max: 60 });
const supportedRegions = envList("MATCHMAKER_SUPPORTED_REGIONS", ["NAE", "EU"]).map((r) => r.toUpperCase());
const defaultRegion = normalizeRegion(envString("MATCHMAKER_DEFAULT_REGION", "NAE"), supportedRegions, "NAE");

const queueByRegion = new Map(supportedRegions.map((r) => [r, []]));
const timerByRegion = new Map();
const countdownByRegion = new Map(supportedRegions.map((r) => [r, 60]));

function getQueue(region) {
  if (!queueByRegion.has(region)) queueByRegion.set(region, []);
  return queueByRegion.get(region);
}

function randomId(prefix) {
  return crypto.createHash("md5").update(`${prefix}:${crypto.randomUUID()}:${Date.now()}`).digest("hex");
}

function schedule(ws, callback, delay) {
  if (!ws.matchmakerTimers) ws.matchmakerTimers = new Set();
  const timer = setTimeout(() => {
    ws.matchmakerTimers?.delete(timer);
    callback();
  }, delay);
  ws.matchmakerTimers.add(timer);
  return timer;
}

function clearSocketTimers(ws) {
  for (const timer of ws.matchmakerTimers || []) {
    clearTimeout(timer);
    clearInterval(timer);
  }
  ws.matchmakerTimers?.clear();
}

function removeFromQueue(ws) {
  if (!ws?.region) return;
  const queue = getQueue(ws.region);
  const index = queue.indexOf(ws);
  if (index !== -1) {
    queue.splice(index, 1);
    log.unqueue(`Player unqueued from ${ws.region}. Queue size: ${queue.length}`);
    broadcastQueueUpdate(ws.region);
  }
}

function broadcastQueueUpdate(region) {
  const queue = getQueue(region);
  const countdown = countdownByRegion.get(region) ?? 60;
  for (const player of queue) {
    if (!player.closed && !player.assigned && player.state === "Queued") {
      sendIfOpen(player, createStatusUpdate("Queued", {
        ticketId: player.ticketId,
        queuedPlayers: queue.length,
        estimatedWaitSec: countdown,
        status: {},
      }));
    }
  }
}

function assignAll(region) {
  const queue = getQueue(region);
  const players = [...queue];
  queueByRegion.set(region, []);
  countdownByRegion.set(region, 60);

  const timer = timerByRegion.get(region);
  if (timer) {
    clearInterval(timer);
    timerByRegion.delete(region);
  }

  const matchId = randomId("match");
  const sessionId = randomId("session");

  for (const player of players) {
    if (player.closed || player.assigned) continue;
    player.assigned = true;
    clearSocketTimers(player);
    sendIfOpen(player, createStatusUpdate("SessionAssignment", { matchId }));
    schedule(player, () => {
      if (!sendIfOpen(player, createPlayMessage(matchId, sessionId, joinDelaySec))) return;
      log.mm(`Session assigned for ${region}: ${sessionId}`);
    }, playDelayMs);
  }
}

function startCountdown(region) {
  if (timerByRegion.has(region)) return;

  const interval = setInterval(() => {
    const queue = getQueue(region);

    if (queue.length === 0) {
      clearInterval(interval);
      timerByRegion.delete(region);
      countdownByRegion.set(region, 60);
      return;
    }

    const current = countdownByRegion.get(region) ?? 60;
    if (current <= 0) {
      clearInterval(interval);
      timerByRegion.delete(region);
      assignAll(region);
      return;
    }

    const next = current - 1;
    countdownByRegion.set(region, next);
    broadcastQueueUpdate(region);
  }, 1000);

  timerByRegion.set(region, interval);
}

function beginMatchmaking(ws, region) {
  if (ws.initialized || ws.closed) return;
  ws.initialized = true;
  ws.region = region;
  ws.ticketId = randomId("ticket");
  ws.matchmakerTimers = new Set();
  ws.assigned = false;
  ws.state = "Connecting";

  const queue = getQueue(region);
  queue.push(ws);

  if (queue.length === 1) {
    countdownByRegion.set(region, 60);
  } else {
    const current = countdownByRegion.get(region) ?? 60;
    countdownByRegion.set(region, Math.max(0, current - 5));
  }

  log.queue(`Player queued in ${region}. Queue size: ${queue.length}`);

  sendIfOpen(ws, createStatusUpdate("Connecting"));

  schedule(ws, () => {
    if (ws.closed) return;
    ws.state = "Waiting";
    sendIfOpen(ws, createStatusUpdate("Waiting", {
      totalPlayers: Math.max(1, queue.length),
      connectedPlayers: Math.max(1, queue.length),
    }));

    schedule(ws, () => {
      if (ws.closed) return;
      ws.state = "Queued";
      const countdown = countdownByRegion.get(region) ?? 60;
      sendIfOpen(ws, createStatusUpdate("Queued", {
        ticketId: ws.ticketId,
        queuedPlayers: queue.length,
        estimatedWaitSec: countdown,
        status: {},
      }));
      startCountdown(region);
    }, 1000);
  }, 800);
}

function setRegionJoinable(region) {
  log.joinable(`Region ${region} marked joinable — assigning all queued players.`);
  assignAll(region);
}

const healthServer = http.createServer((req, res) => {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  const parts = requestUrl.pathname.split("/").filter(Boolean);
  const action = parts[0]?.toLowerCase();
  const requestedRegion = parts[1]?.toUpperCase();
  const region = supportedRegions.includes(requestedRegion) ? requestedRegion : null;

  if (req.method === "GET" && (requestUrl.pathname === "/" || requestUrl.pathname === "/health")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      status: "ok",
      websocketPort: wsPort,
      regions: Object.fromEntries(supportedRegions.map((r) => [r, {
        queuedPlayers: getQueue(r).length,
        countdown: countdownByRegion.get(r) ?? 60,
      }])),
    }));
  }

  if (!region) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("Invalid endpoint or region");
  }

  if (req.method === "GET" && action === "joinable") {
    setRegionJoinable(region);
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("Joinable");
  }

  if (req.method === "GET" && action === "notjoinable") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("Not Joinable");
  }

  if (req.method === "GET" && action === "queuedplayers") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end(String(getQueue(region).length));
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  return res.end("Invalid endpoint or region");
});

const wss = new WebSocketServer({ port: wsPort });

wss.on("listening", () => {
  log.mm(`started listening on port ${wsPort}`);
});

healthServer.listen(httpPort, () => {
  log.http(`started on port ${httpPort}`);
});

wss.on("connection", (ws, req) => {
  if (String(ws.protocol || "").toLowerCase().includes("xmpp")) {
    log.error("XMPP protocol reached the matchmaker port; closing it.");
    return ws.close(1002, "Invalid protocol");
  }

  ws.closed = false;
  const rawUrl = String(req.url || "/");
  const queryString = rawUrl.includes("?") ? rawUrl.slice(rawUrl.indexOf("?") + 1) : "";
  const queryRegion = new URLSearchParams(queryString).get("region")?.toUpperCase();
  const authorizationRegion = parseAuthorizationRegion(req.headers.authorization, supportedRegions);
  const region = normalizeRegion(queryRegion || authorizationRegion, supportedRegions, defaultRegion);

  log.mm(`WebSocket connection from ${req.socket.remoteAddress || "unknown"}; region=${region}`);
  beginMatchmaking(ws, region);

  ws.on("message", (message) => {
    const text = message.toString();
    if (text.toLowerCase() === "ping") sendIfOpen(ws, "pong");
  });

  ws.on("close", (code, reasonBuffer) => {
    ws.closed = true;
    clearSocketTimers(ws);
    removeFromQueue(ws);
    const reason = reasonBuffer?.toString?.() || "none";
    log.mm(`WebSocket closed: code=${code}, reason=${reason}`);
  });

  ws.on("error", (error) => {
    log.error(`Matchmaker WebSocket error: ${error.message}`);
  });
});

export { healthServer, queueByRegion, wss };
