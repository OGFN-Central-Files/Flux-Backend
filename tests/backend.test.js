import test from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";

import { data as createCommand } from "../src/discord/commands/user/Create.js";
import { generateAccountCredentials } from "../src/discord/utils/accountCredentials.js";
import { envBoolean, envInteger, envList } from "../src/Config/env.js";
import Utils from "../src/Utils/Utils.js";
import User from "../src/User/Mongodb/Schema/user.js";
import Profile from "../src/User/Mongodb/Schema/profiles.js";
import Friends from "../src/User/Mongodb/Schema/friends.js";
import profileManager from "../src/User/profile.js";
import { applyRewardAtomically } from "../src/discord/utils/rewardUtils.js";
import { calculateProgress } from "../src/api/XP.js";
import { privateApiMiddleware } from "../src/api/utils/service.js";

function stub(object, key, replacement) {
  const original = object[key];
  object[key] = replacement;
  return () => {
    object[key] = original;
  };
}

test("environment parsing is bounded and predictable", () => {
  process.env.TEST_BOOLEAN = "yes";
  process.env.TEST_INTEGER = "999";
  process.env.TEST_LIST = "one, two,,three";

  assert.equal(envBoolean("TEST_BOOLEAN", false), true);
  assert.equal(envInteger("TEST_INTEGER", 5, { min: 1, max: 20 }), 20);
  assert.deepEqual(envList("TEST_LIST"), ["one", "two", "three"]);
});

test("/create is registered with zero command options", () => {
  const json = createCommand.toJSON();
  assert.equal(json.name, "create");
  assert.deepEqual(json.options ?? [], []);
  assert.equal(json.dm_permission, false);
});

test("generated account credentials are private, valid, and unique-shaped", async () => {
  const restoreExists = stub(User, "exists", async () => null);
  const previousDomain = process.env.ACCOUNT_EMAIL_DOMAIN;
  const previousLength = process.env.ACCOUNT_PASSWORD_LENGTH;
  const previousPrefix = process.env.ACCOUNT_USERNAME_PREFIX;

  process.env.ACCOUNT_EMAIL_DOMAIN = "accounts.example.test";
  process.env.ACCOUNT_PASSWORD_LENGTH = "20";
  process.env.ACCOUNT_USERNAME_PREFIX = "zv";

  try {
    const credentials = await generateAccountCredentials({
      id: "123456789012345678",
      username: "Roger! Test",
      globalName: "Roger! Test",
    });

    assert.match(credentials.username, /^zv_RogerTest/);
    assert.match(credentials.email, /\.345678@accounts\.example\.test$/);
    assert.equal(credentials.password.length, 20);
    assert.match(credentials.password, /[A-Z]/);
    assert.match(credentials.password, /[a-z]/);
    assert.match(credentials.password, /[2-9]/);
    assert.match(credentials.password, /[!@#$%]/);
    assert.doesNotMatch(credentials.password, /[O0Il1]/);
  } finally {
    restoreExists();
    if (previousDomain === undefined) delete process.env.ACCOUNT_EMAIL_DOMAIN;
    else process.env.ACCOUNT_EMAIL_DOMAIN = previousDomain;
    if (previousLength === undefined) delete process.env.ACCOUNT_PASSWORD_LENGTH;
    else process.env.ACCOUNT_PASSWORD_LENGTH = previousLength;
    if (previousPrefix === undefined) delete process.env.ACCOUNT_USERNAME_PREFIX;
    else process.env.ACCOUNT_USERNAME_PREFIX = previousPrefix;
  }
});

test("CreateUser hashes the password and creates all account documents", async () => {
  const calls = { user: null, profile: null, friends: null };
  const restores = [
    stub(User, "findOne", () => ({ lean: async () => null })),
    stub(User, "create", async (document) => {
      calls.user = document;
      return document;
    }),
    stub(Profile, "create", async (document) => {
      calls.profile = document;
      return document;
    }),
    stub(Friends, "create", async (document) => {
      calls.friends = document;
      return document;
    }),
    stub(profileManager, "createProfiles", async (accountId) => ({
      athena: { accountId },
      common_core: { accountId },
    })),
  ];

  try {
    const result = await Utils.CreateUser(
      "123456789012345678",
      "TestPlayer",
      "Test@Example.com",
      "VerySecurePassword123!",
      false
    );

    assert.equal(result.status, 201);
    assert.equal(calls.user.banned, false);
    assert.equal(calls.user.email, "test@example.com");
    assert.notEqual(calls.user.password, "VerySecurePassword123!");
    assert.equal(await bcrypt.compare("VerySecurePassword123!", calls.user.password), true);
    assert.equal(calls.profile.accountId, calls.user.accountId);
    assert.equal(calls.friends.accountId, calls.user.accountId);
  } finally {
    restores.reverse().forEach((restore) => restore());
  }
});

test("CreateUser rolls back partial account data when profile creation fails", async () => {
  const deleted = [];
  const restores = [
    stub(User, "findOne", () => ({ lean: async () => null })),
    stub(User, "create", async (document) => document),
    stub(Profile, "create", async () => {
      throw new Error("profile failure");
    }),
    stub(Friends, "create", async (document) => document),
    stub(User, "deleteOne", async (query) => deleted.push(["user", query.accountId])),
    stub(Profile, "deleteOne", async (query) => deleted.push(["profile", query.accountId])),
    stub(Friends, "deleteOne", async (query) => deleted.push(["friends", query.accountId])),
    stub(profileManager, "createProfiles", async () => ({})),
  ];

  try {
    const result = await Utils.CreateUser(
      "876543210987654321",
      "RollbackPlayer",
      "rollback@example.com",
      "VerySecurePassword123!",
      false
    );

    assert.equal(result.status, 500);
    assert.deepEqual(
      deleted.map(([type]) => type).sort(),
      ["friends", "profile", "user"]
    );
  } finally {
    restores.reverse().forEach((restore) => restore());
  }
});

test("all Discord command modules load and have unique slash-command names", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const commandRoot = path.join(process.cwd(), "src", "discord", "commands");
  const names = new Set();

  for (const folder of fs.readdirSync(commandRoot, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    const folderPath = path.join(commandRoot, folder.name);
    for (const filename of fs.readdirSync(folderPath)) {
      if (!filename.endsWith(".js")) continue;
      const module = await import(pathToFileURL(path.join(folderPath, filename)).href);
      assert.equal(typeof module.execute, "function", `${filename} must export execute()`);
      const json = module.data.toJSON();
      assert.ok(json.name, `${filename} must have a command name`);
      assert.equal(names.has(json.name), false, `duplicate command name: ${json.name}`);
      names.add(json.name);
    }
  }

  assert.ok(names.has("create"));
  assert.ok(names.has("ban"));
  assert.ok(names.has("unban"));
});


test("reward claims use one conditional atomic profile update", async () => {
  let capturedQuery;
  let capturedUpdate;
  const restoreUpdate = stub(Profile, "updateOne", async (query, update) => {
    capturedQuery = query;
    capturedUpdate = update;
    return { modifiedCount: 1 };
  });

  try {
    const applied = await applyRewardAtomically({
      accountId: "account-123",
      marker: "ExampleRewardClaimed",
      set: { "profiles.athena.items.Test:Item": { quantity: 1 } },
      increment: { "profiles.common_core.items.Currency:MtxPurchased.quantity": 500 },
    });

    assert.equal(applied, true);
    assert.deepEqual(capturedQuery, {
      accountId: "account-123",
      "profiles.common_core.items.stats.attributes.ExampleRewardClaimed": { $ne: true },
    });
    assert.equal(
      capturedUpdate.$set["profiles.common_core.items.stats.attributes.ExampleRewardClaimed"],
      true
    );
    assert.equal(capturedUpdate.$inc["profiles.athena.rvn"], 1);
    assert.equal(capturedUpdate.$inc["profiles.common_core.commandRevision"], 1);
    assert.equal(
      capturedUpdate.$inc["profiles.common_core.items.Currency:MtxPurchased.quantity"],
      500
    );
  } finally {
    restoreUpdate();
  }
});


test("XP progression uses the current level requirement", () => {
  const result = calculateProgress(
    { xp: 0, level: 1, book_xp: 0, book_level: 0 },
    100
  );
  assert.equal(result.level, 2);
  assert.equal(result.xp, 0);
});

test("private API middleware rejects a missing key", () => {
  const middleware = privateApiMiddleware({
    key: "unit-test-private-key",
    required: true,
    serviceName: "unit-test-api",
  });
  let statusCode = 200;
  let payload;
  let nextCalled = false;
  const req = { ip: "127.0.0.1", get: () => undefined };
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(value) {
      payload = value;
      return this;
    },
  };

  middleware(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false);
  assert.equal(statusCode, 401);
  assert.deepEqual(payload, { error: "unauthorized" });
});

test("matchmaker protocol sends valid Fortnite 9.x status payloads", async () => {
  const {
    createPlayMessage,
    createStatusUpdate,
    normalizeMatchmakerUrl,
    parseAuthorizationRegion,
    parseGameServerAddress,
  } = await import("../src/matchmaker/src/protocol.js");

  const connecting = JSON.parse(createStatusUpdate("Connecting"));
  assert.deepEqual(connecting, { payload: { state: "Connecting" }, name: "StatusUpdate" });

  const queued = JSON.parse(
    createStatusUpdate("Queued", {
      ticketId: "ticket-123",
      queuedPlayers: 0,
      estimatedWaitSec: 1,
    })
  );
  assert.equal(queued.payload.state, "Queued");
  assert.equal(queued.payload.ticketId, "ticket-123");
  assert.equal(queued.payload.queuedPlayers, 0);

  const assignment = JSON.parse(
    createStatusUpdate("SessionAssignment", { matchId: "match-123" })
  );
  assert.equal(assignment.payload.matchId, "match-123");

  const play = JSON.parse(createPlayMessage("match-123", "session-123", 1));
  assert.deepEqual(play.payload, {
    matchId: "match-123",
    sessionId: "session-123",
    joinDelaySec: 1,
  });

  assert.equal(
    parseAuthorizationRegion("Epic-Signed mms-player account NAE Playlist_DefaultSolo 9", ["NAE", "EU"]),
    "NAE"
  );
  assert.equal(normalizeMatchmakerUrl("127.0.0.1", 81), "ws://127.0.0.1:81");
  assert.deepEqual(parseGameServerAddress("127.0.0.1:7777:Playlist_DefaultSolo"), {
    host: "127.0.0.1",
    port: 7777,
  });
});
