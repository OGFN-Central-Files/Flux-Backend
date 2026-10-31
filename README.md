# Flux Backend

A Node.js Fortnite backend with MongoDB accounts, Discord account management, launcher authentication, shop/leaderboard endpoints, XMPP, matchmaking, and optional reward services.

## Requirements

- Node.js 20 or newer
- MongoDB
- A Discord application and bot when Discord commands are enabled

## Setup

### Fast Windows setup

Run `setup-env.bat`. It backs up an existing `.env`, asks only for the important values, and generates separate random game/launcher secrets. Then run `npm run config:check`.

### Manual setup

1. Copy `.env.minimal.example` to `.env` for a simple setup, or use `.env.example` when you need every advanced option.
2. Fill in `MONGO_URI`, Discord credentials, `MATCHMAKER_PUBLIC_URL`, and each enabled region's `GAME_SERVER_REGION` value.
3. Generate different long random values for `GAME_JWT_SECRET`, `LAUNCHER_JWT_SECRET`, `DISCORD_SESSION_SECRET`, and private API keys.
4. Install and validate the backend:

```bash
npm ci
npm run config:check
npm run check
npm test
```

5. Start the main backend:

```bash
npm start
```

On Windows, `start.bat` starts the main service and `start_all.bat` starts the optional companion APIs in separate terminals.

## Discord `/create`

`/create` intentionally has **no command options**. A user submits the command and the backend:

1. Confirms that the Discord account does not already own a backend account.
2. Generates a unique username, synthetic login email, and secure random password.
3. Creates the user, profiles, and friends records.
4. Sends the credentials directly to the user's Discord DMs.
5. Removes the newly created account when the DM fails and `ACCOUNT_DM_REQUIRED=true`.

The generated plaintext password is never saved to MongoDB or written to the audit webhook. Only its bcrypt hash is stored. Users must allow DMs from the server when DM delivery is required.

Important account-generation settings:

```dotenv
ACCOUNT_EMAIL_DOMAIN=flux.dev
ACCOUNT_USERNAME_PREFIX=
ACCOUNT_USERNAME_MAX_LENGTH=24
ACCOUNT_PASSWORD_LENGTH=16
ACCOUNT_GENERATION_ATTEMPTS=30
ACCOUNT_DM_REQUIRED=true
CREATE_PUBLIC_ANNOUNCEMENT=false
BCRYPT_ROUNDS=10
```

Run command deployment automatically with `DISCORD_AUTO_DEPLOY_COMMANDS=true`, or deploy the definitions manually with `npm run deploy:commands`. Set `DISCORD_COMMAND_SCOPE=guild` during development for immediate guild command updates; this requires `GUILD_ID`.

## Discord commands

| Command | Purpose |
|---|---|
| `/create` | Generate an account and DM its credentials |
| `/deleteaccount` | Permanently delete the caller's linked account after confirmation |
| `/username` | Change the caller's linked username |
| `/ban` | Ban a linked account and revoke active sessions |
| `/unban` | Remove a linked account ban |
| `/claim-booster-rewards` | Claim configured booster rewards once |
| `/claim-full-locker` | Claim configured full-locker rewards once |
| `/claim-legacy-bundle` | Claim configured legacy rewards once |

Command channels, required roles, colors, branding, public announcements, confirmation timeout, webhooks, and reward roles are configurable in `.env`.

## Launcher API

The launcher uses the same account records and password hashes as the game backend. Both `/api/launcher` and the compatibility prefix `/launcher` are mounted.

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/launcher/login` | Log in with `{ "identifier": "email or username", "password": "..." }` |
| `POST` | `/api/launcher/auth/login` | Alias for launcher login |
| `GET` | `/api/launcher/me` | Read the authenticated account |
| `GET` | `/api/launcher/auth/me` | Alias for authenticated account data |
| `POST` | `/api/launcher/logout` | Revoke the current account's launcher sessions |
| `GET` | `/api/launcher/shop` | Return normalized launcher shop sections and items |
| `GET` | `/api/launcher/shop/raw` | Return the original catalog storefronts |
| `GET` | `/api/launcher/leaderboard?type=arena&page=1&limit=50` | Paginated leaderboard |
| `GET` | `/api/launcher/leaderboard/:type` | Leaderboard alias; supported types include arena, wins, kills, and tournament |

Use `Authorization: Bearer <accessToken>` for protected launcher routes. Bans, account deletion, username changes, explicit logout, and forced session revocation invalidate previously issued launcher tokens through the account token version.

The legacy GET login route is disabled by default because credentials can leak through URLs and logs. Enable it only for an old launcher using `LAUNCHER_ENABLE_LEGACY_GET_LOGIN=true`.


## Matchmaking and queue stability

The matchmaker returns the Fortnite 9.x status sequence in this order:

```text
Connecting -> Waiting -> Queued -> SessionAssignment -> Play
```

`Queued` always contains a ticket ID, and `SessionAssignment` always contains a match ID. The matchmaker accepts the `//` WebSocket path used by older clients and obtains the region from the matchmaking authorization payload when the URL has no query string.

Important settings:

```dotenv
MATCHMAKER_PUBLIC_URL=ws://127.0.0.1:81
MATCHMAKER_SUPPORTED_REGIONS=NAE,EU
MATCHMAKER_DEFAULT_REGION=NAE
GAME_SERVER_NAE=127.0.0.1:7777
GAME_SERVER_EU=127.0.0.1:7777
MATCHMAKER_AUTO_JOINABLE=false
GAME_SINGLE_SESSION_PER_ACCOUNT=false
```

With `MATCHMAKER_AUTO_JOINABLE=false`, the game server should call `GET /joinable/NAE` (or its region) on the matchmaker HTTP port when ready. Set it to `true` only for local testing that should immediately assign a session.

Game token refreshes are rotated without closing XMPP or invalidating the previous access token during concurrent requests. Explicit logout, bans, and session-kill calls still revoke sessions.

## Main service configuration

The main service defaults to port `3551`. Important groups in `.env.example` include:

- HTTP host, body size, proxy behavior, global rate limits, and route-load behavior
- MongoDB connection and timeout
- game and launcher JWT secrets
- launcher API key validation with `LAUNCHER_API_KEY_HEADER`, `LAUNCHER_API_KEY`, and `LAUNCHER_API_KEY_REQUIRED`
- Discord bot behavior, command scope, status, branding, audit webhook, and role IDs
- XMPP and matchmaking ports and enable/required flags
- shop rotation schedule, API URL, webhook, and force-rotation key
- reward command enable switches, role IDs, gift text, V-Bucks amount, and full-locker gift chunk size
- optional reward, Lawin, quest, and Discord OAuth services

Do not commit `.env`, `tokens.json`, logs, or `node_modules`. These are ignored by the included `.gitignore`.

## Optional services

| Script | Default port | Description |
|---|---:|---|
| `npm run start:discord-auth` | 99 | Discord OAuth/session service |
| `npm run start:shop-rotator` | 75 | Catalog rotation service |
| `npm run start:hype` | 90 | Arena hype reward API |
| `npm run start:vbucks` | 92 | V-Bucks reward API |
| `npm run start:umbrella` | 93 | Umbrella reward API |
| `npm run start:xp` | 78 | XP reward API |
| `npm run start:quest` | 88 | Quest progress API |
| `npm run start:lawin` | 94 | Lawin compatibility API |

Each service port and private key can be changed in `.env`. Keep these private APIs behind a firewall or trusted reverse proxy and use separate random API keys in production.


### Private reward APIs

Mutation APIs require `X-API-Key` by default. Set `REWARDS_API_KEY` and keep `REWARDS_API_REQUIRE_KEY=true`. Preferred routes use POST bodies:

```text
POST /api/v1/rewards/managehype/:username   { "reason": "Win" }
POST /api/v1/rewards/vbucks/:username       { "amount": 200 }
POST /api/v1/rewards/season_umbrella/:username
POST /api/v1/xp/:username                    { "amount": 1000 }
```

Compatibility GET routes remain available when `REWARDS_ENABLE_LEGACY_GET=true`. Request limits, hype values, bus-fare tiers, match-stat tracking, umbrella template, XP level cap, and paid battle-pass rewards are configurable in `.env`.

The XP service now calculates level requirements from the current level, grants each newly reached battle-pass tier once, and writes XP plus earned rewards in one optimistic update. A conflicting profile update returns HTTP `409` instead of silently overwriting newer profile data.

### Quest API

Preferred route:

```http
POST /api/v1/quest/:username/:questId/progress
X-API-Key: <QUEST_API_KEY>
Content-Type: application/json

{ "count": 1 }
```

The old GET mutation route can be disabled with `QUEST_ENABLE_LEGACY_GET=false`. Maximum progress per request and the progress attribute are configurable.

## Health checks

- Main backend: `GET /health`
- Matchmaker HTTP service: `GET /health`
- Quest API: `GET /health`

The main health response reports process uptime and whether MongoDB and Discord are connected without exposing credentials.

## Validation

```bash
npm run config:check  # validate required values, game servers, URLs, and port conflicts
npm run check         # syntax-check every JavaScript source file
npm test              # account, command, matchmaking, rewards, XP, and API-security tests
npm audit --omit=dev
```

A full live launch still requires working MongoDB, Discord, network, and game configuration values in `.env`.

## License and attribution

This project retains its existing GPL-3.0 license and original Zayven Services attribution.

## Customizing the Launcher Shop

The launcher shop has two modes. Pick one and stick with it.

If you want to hand-pick the shop, use this:

```env
CUSTOM_SHOP=true
ROTATE_SHOP=false
```

When custom shop is on, the backend reads only `Config/catalog_config.json`. It does not mix in the auto-rotated catalog.

If you want the backend to rotate the shop for you, use this:

```env
CUSTOM_SHOP=false
ROTATE_SHOP=true
```

When autorotation is on, the backend reads only `src/local/Storefront/Catalog.json`, which the shop rotator updates.

### Season Limit

Use `SHOP_MAX_SEASON` to keep the shop era-accurate:

```env
MAIN_SEASON=9
SHOP_MAX_SEASON=5
```

`SHOP_MAX_SEASON=5` means items introduced in season 5 or earlier are allowed. Items introduced after season 5 are filtered out of the launcher shop and will not be selected by autorotation.

### Editing the Custom Shop

Open `Config/catalog_config.json`.

A simple daily item looks like this:

```json
{
  "item": "EID_DanceMoves",
  "price": 500,
  "panel": "Panel 1"
}
```

A featured bundle looks like this:

```json
{
  "name": "Cyber Bundle",
  "bundle": [
    "CID_452_Athena_Commando_F_CyberFu",
    "BID_331_CyberFu"
  ],
  "price": 1800,
  "panel": "Panel 7"
}
```

Put daily offers under `daily` and featured offers under `featured`:

```json
{
  "featured": [
    {
      "name": "Cyber Bundle",
      "bundle": ["CID_452_Athena_Commando_F_CyberFu", "BID_331_CyberFu"],
      "price": 1800,
      "panel": "Panel 7"
    }
  ],
  "daily": [
    {
      "item": "EID_DanceMoves",
      "price": 500,
      "panel": "Panel 1"
    }
  ]
}
```

You can use plain cosmetic IDs like `CID_...`, `BID_...`, `Pickaxe_ID_...`, `Glider_ID_...`, `EID_...`, and `Wrap_...`. The backend guesses the correct template type. If you want to be exact, you can also write the full template ID, like `AthenaCharacter:CID_452_Athena_Commando_F_CyberFu`.

### Panels

Panels control how the launcher groups cards.

Daily panels usually start at `Panel 1`.
Featured panels usually start at `Panel 7`.

If two offers use the same panel, they appear together in that panel. If every offer has a different panel, they appear as separate cards/groups.

### Autorotation

When `CUSTOM_SHOP=false` and `ROTATE_SHOP=true`, the rotator chooses items automatically. These settings control how many panels it creates:

```env
SHOP_AUTOROTATE_DAILY_PANELS=6
SHOP_AUTOROTATE_FEATURED_PANELS=4
```

The rotator also respects `SHOP_MAX_SEASON`, so it will not pick items newer than your max season.

### Quick Rules

- Use `CUSTOM_SHOP=true` when you want full control.
- Use `CUSTOM_SHOP=false` when you want automatic rotation.
- Do not enable both custom and autorotation expecting them to merge.
- Bundles are just arrays of item IDs.
- `name` is optional for single items, but useful for bundles.
- If an item does not show artwork, check that the ID exists in Fortnite-API for your season.

Useful endpoints:

```text
GET /api/launcher/shop
GET /api/launcher/shop/status
GET /api/launcher/shop?section=featured
GET /api/launcher/shop?panel=panel-7
GET /api/launcher/shop?search=raider
```

## Launcher leaderboard schema v2

The leaderboard remains backward compatible and now also includes `summary` and `topThree` fields.

```text
GET /api/launcher/leaderboard?type=arena&page=1&limit=25
GET /api/launcher/leaderboard?type=wins&search=player
GET /api/launcher/leaderboard?type=kills&includeZero=false
```

Optional settings:

```dotenv
LEADERBOARD_DEFAULT_LIMIT=25
LEADERBOARD_CACHE_SECONDS=15
LEADERBOARD_INCLUDE_ZERO_SCORES=true
```
