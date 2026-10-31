import express from "express";
import crypto from "node:crypto";
import { verifyToken } from "../User/tokenManager/tokenVerify.js";

const app = express.Router();
const parties = new Map();
const accountParty = new Map();

function now() {
  return new Date().toISOString();
}

function connectionFor(accountId, requestBody = {}) {
  const timestamp = now();
  return {
    id: requestBody.connection?.id || requestBody.connectionId || crypto.randomUUID(),
    connected_at: timestamp,
    updated_at: timestamp,
    yield_leadership: false,
    meta: requestBody.connection?.meta || requestBody.connection_meta || {},
  };
}

function memberFor(user, body = {}) {
  const timestamp = now();
  return {
    account_id: user.accountId,
    meta: body.meta || {},
    connections: [connectionFor(user.accountId, body)],
    revision: 0,
    updated_at: timestamp,
    joined_at: timestamp,
    role: "CAPTAIN",
  };
}

function publicParty(party) {
  return {
    id: party.id,
    created_at: party.created_at,
    updated_at: party.updated_at,
    config: party.config,
    members: party.members,
    applicants: [],
    meta: party.meta,
    invites: [],
    revision: party.revision,
  };
}

function getOwnedParty(accountId) {
  const partyId = accountParty.get(accountId);
  return partyId ? parties.get(partyId) : null;
}

app.get("/party/api/v1/Fortnite/user/:accountId", verifyToken, (req, res) => {
  if (req.params.accountId !== req.user.accountId) return res.status(403).end();
  const party = getOwnedParty(req.user.accountId);
  return res.json({
    current: party ? [publicParty(party)] : [],
    pending: [],
    invites: [],
    pings: [],
  });
});

app.post("/party/api/v1/Fortnite/parties", verifyToken, (req, res) => {
  const existing = getOwnedParty(req.user.accountId);
  if (existing) return res.status(200).json(publicParty(existing));

  const timestamp = now();
  const party = {
    id: crypto.randomUUID().replace(/-/g, ""),
    created_at: timestamp,
    updated_at: timestamp,
    config: {
      join_confirmation: false,
      joinability: "OPEN",
      max_size: 16,
      sub_type: "default",
      type: "DEFAULT",
      discoverability: "ALL",
      ...req.body?.config,
    },
    members: [memberFor(req.user, req.body || {})],
    meta: req.body?.meta || {},
    revision: 0,
  };

  parties.set(party.id, party);
  accountParty.set(req.user.accountId, party.id);
  return res.status(200).json(publicParty(party));
});

app.get("/party/api/v1/Fortnite/parties/:partyId", verifyToken, (req, res) => {
  const party = parties.get(req.params.partyId);
  if (!party) return res.status(404).json({ errorCode: "errors.com.epicgames.social.party.party_not_found" });
  return res.json(publicParty(party));
});

app.patch("/party/api/v1/Fortnite/parties/:partyId", verifyToken, (req, res) => {
  const party = parties.get(req.params.partyId);
  if (!party) return res.status(404).end();
  if (!party.members.some((member) => member.account_id === req.user.accountId)) return res.status(403).end();

  party.meta = { ...party.meta, ...(req.body?.update || req.body?.meta || {}) };
  for (const key of req.body?.delete || []) delete party.meta[key];
  party.config = { ...party.config, ...(req.body?.config || {}) };
  party.revision += 1;
  party.updated_at = now();
  return res.status(204).end();
});

app.patch(
  "/party/api/v1/Fortnite/parties/:partyId/members/:accountId/meta",
  verifyToken,
  (req, res) => {
    const party = parties.get(req.params.partyId);
    if (!party) return res.status(404).end();
    if (req.params.accountId !== req.user.accountId) return res.status(403).end();
    const member = party.members.find((entry) => entry.account_id === req.params.accountId);
    if (!member) return res.status(404).end();

    member.meta = { ...member.meta, ...(req.body?.update || req.body?.meta || {}) };
    for (const key of req.body?.delete || []) delete member.meta[key];
    member.revision += 1;
    member.updated_at = now();
    party.revision += 1;
    party.updated_at = now();
    return res.status(204).end();
  }
);

app.post(
  "/party/api/v1/Fortnite/parties/:partyId/members/:accountId/meta",
  verifyToken,
  (req, res) => {
    const party = parties.get(req.params.partyId);
    if (!party) return res.status(404).end();
    if (req.params.accountId !== req.user.accountId) return res.status(403).end();
    const member = party.members.find((entry) => entry.account_id === req.params.accountId);
    if (!member) return res.status(404).end();
    member.meta = { ...member.meta, ...(req.body || {}) };
    member.revision += 1;
    member.updated_at = now();
    party.revision += 1;
    party.updated_at = now();
    return res.status(204).end();
  }
);

app.delete(
  "/party/api/v1/Fortnite/parties/:partyId/members/:accountId",
  verifyToken,
  (req, res) => {
    const party = parties.get(req.params.partyId);
    if (!party) return res.status(204).end();
    if (req.params.accountId !== req.user.accountId) return res.status(403).end();

    party.members = party.members.filter((member) => member.account_id !== req.params.accountId);
    accountParty.delete(req.params.accountId);
    if (party.members.length === 0) parties.delete(party.id);
    else {
      party.revision += 1;
      party.updated_at = now();
    }
    return res.status(204).end();
  }
);

app.post("/party/api/v1/Fortnite/parties/:partyId/members/:accountId/promote", verifyToken, (_req, res) => {
  return res.status(204).end();
});

app.post("/party/api/v1/Fortnite/parties/:partyId/invites/:accountId", verifyToken, (_req, res) => {
  return res.status(204).end();
});

app.delete("/party/api/v1/Fortnite/parties/:partyId/invites/:accountId", verifyToken, (_req, res) => {
  return res.status(204).end();
});

app.post("/party/api/v1/Fortnite/user/:accountId/pings/:pingerId", verifyToken, (_req, res) => {
  return res.status(204).end();
});

app.delete("/party/api/v1/Fortnite/user/:accountId/pings/:pingerId", verifyToken, (_req, res) => {
  return res.status(204).end();
});

export { accountParty, parties };
export default app;
