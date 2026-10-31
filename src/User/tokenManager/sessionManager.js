import jwt from "jsonwebtoken";
import Utils from "../../Utils/Utils.js";

export function normalizeStoredToken(value) {
  const token = String(value || "").trim();
  if (!token) return "";
  return token.startsWith("eg1~") ? token : `eg1~${token}`;
}

export function decodeStoredToken(value) {
  const token = normalizeStoredToken(value);
  if (!token) return null;
  try {
    return jwt.verify(token.replace(/^eg1~/, ""), global.JWT_SECRET);
  } catch {
    return null;
  }
}

export function pruneExpiredTokens() {
  const valid = (entry) => Boolean(decodeStoredToken(entry?.token));
  global.accessTokens = Array.isArray(global.accessTokens) ? global.accessTokens.filter(valid) : [];
  global.refreshTokens = Array.isArray(global.refreshTokens) ? global.refreshTokens.filter(valid) : [];
  global.clientTokens = Array.isArray(global.clientTokens) ? global.clientTokens.filter(valid) : [];
}

export async function revokeToken(value, { closeXmpp = false } = {}) {
  const token = normalizeStoredToken(value);
  if (!token) return { removed: false, accountId: null };

  const accessEntry = global.accessTokens.find((entry) => entry.token === token);
  const refreshEntry = global.refreshTokens.find((entry) => entry.token === token);
  const clientEntry = global.clientTokens.find((entry) => entry.token === token);
  const accountId = accessEntry?.accountId || refreshEntry?.accountId || null;

  global.accessTokens = global.accessTokens.filter((entry) => entry.token !== token);
  global.refreshTokens = global.refreshTokens.filter((entry) => entry.token !== token);
  global.clientTokens = global.clientTokens.filter((entry) => entry.token !== token);

  const removed = Boolean(accessEntry || refreshEntry || clientEntry);
  if (removed) await Utils.UpdateTokens();

  if (closeXmpp && accountId) {
    const client = global.Clients?.find((entry) => entry.accountId === accountId);
    try {
      client?.client?.close();
    } catch {}
  }

  return { removed, accountId };
}

export async function revokeAccountGameSessions(accountId, { closeXmpp = true } = {}) {
  if (!accountId) return false;
  const before = (global.accessTokens?.length || 0) + (global.refreshTokens?.length || 0);
  global.accessTokens = (global.accessTokens || []).filter((entry) => entry.accountId !== accountId);
  global.refreshTokens = (global.refreshTokens || []).filter((entry) => entry.accountId !== accountId);
  const after = global.accessTokens.length + global.refreshTokens.length;

  if (before !== after) await Utils.UpdateTokens();
  if (closeXmpp) {
    const client = global.Clients?.find((entry) => entry.accountId === accountId);
    try {
      client?.client?.close();
    } catch {}
  }
  return before !== after;
}

export function limitAccountTokens(accountId, maximum = 5) {
  const entries = global.accessTokens.filter((entry) => entry.accountId === accountId);
  if (entries.length <= maximum) return;
  const remove = new Set(entries.slice(0, entries.length - maximum).map((entry) => entry.token));
  global.accessTokens = global.accessTokens.filter((entry) => !remove.has(entry.token));
}
