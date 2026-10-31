import { WebSocket } from "ws";

export function normalizeRegion(value, supportedRegions = ["NAE", "EU"], fallback = "NAE") {
  const supported = new Set(supportedRegions.map((region) => String(region).trim().toUpperCase()));
  const normalized = String(value || "").trim().toUpperCase();
  if (supported.has(normalized)) return normalized;

  const normalizedFallback = String(fallback || "").trim().toUpperCase();
  if (supported.has(normalizedFallback)) return normalizedFallback;
  return supported.values().next().value || "NAE";
}

export function parseAuthorizationRegion(header, supportedRegions = ["NAE", "EU"]) {
  const parts = String(header || "").trim().split(/\s+/).filter(Boolean);
  const accountIndex = parts.findIndex((part) => part.toLowerCase() === "account");
  if (accountIndex === -1 || !parts[accountIndex + 1]) return null;

  const candidate = parts[accountIndex + 1].toUpperCase();
  return supportedRegions.map((region) => region.toUpperCase()).includes(candidate)
    ? candidate
    : null;
}

export function normalizeMatchmakerUrl(configuredValue, fallbackPort = 81) {
  let value = String(configuredValue || "").trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }
  if (!value) value = `ws://127.0.0.1:${fallbackPort}`;
  if (!/^wss?:\/\//i.test(value)) value = `ws://${value}`;

  const url = new URL(value);
  if (!url.port) url.port = String(fallbackPort);
  url.search = "";
  url.hash = "";
  if (url.pathname === "/") url.pathname = "";
  return url.toString().replace(/\/$/, "");
}

export function parseGameServerAddress(value, fallbackPort = 7777) {
  let input = String(value || "").trim();
  if ((input.startsWith('"') && input.endsWith('"')) || (input.startsWith("'") && input.endsWith("'"))) {
    input = input.slice(1, -1).trim();
  }
  if (!input) return null;
  input = input.replace(/^https?:\/\//i, "").replace(/^wss?:\/\//i, "");
  input = input.split("/")[0];

  // Existing configurations sometimes append the playlist after host:port.
  // Only the first two colon-delimited values are relevant for IPv4/hostnames.
  const parts = input.split(":");
  const host = parts[0]?.trim();
  const parsedPort = Number.parseInt(parts[1] || String(fallbackPort), 10);
  if (!host || !Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    return null;
  }

  return { host, port: parsedPort };
}

export function createStatusUpdate(state, options = {}) {
  let payload;
  switch (state) {
    case "Connecting":
      payload = { state };
      break;
    case "Waiting":
      payload = {
        totalPlayers: Math.max(1, Number(options.totalPlayers) || 1),
        connectedPlayers: Math.max(1, Number(options.connectedPlayers) || 1),
        state,
      };
      break;
    case "Queued":
      payload = {
        ticketId: String(options.ticketId || ""),
        queuedPlayers: Math.max(0, Number(options.queuedPlayers) || 0),
        estimatedWaitSec: Math.max(0, Number(options.estimatedWaitSec) || 0),
        status: options.status && typeof options.status === "object" ? options.status : {},
        state,
      };
      break;
    case "SessionAssignment":
      payload = {
        matchId: String(options.matchId || ""),
        state,
      };
      break;
    default:
      payload = { state };
  }

  return JSON.stringify({ payload, name: "StatusUpdate" });
}

export function createPlayMessage(matchId, sessionId, joinDelaySec = 1) {
  return JSON.stringify({
    payload: {
      matchId: String(matchId),
      sessionId: String(sessionId),
      joinDelaySec: Math.max(0, Number(joinDelaySec) || 0),
    },
    name: "Play",
  });
}

export function sendIfOpen(ws, data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(data);
    return true;
  } catch {
    return false;
  }
}
