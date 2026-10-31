// Test-only defaults. Production still requires real secrets in .env.
process.env.NODE_ENV = "test";
process.env.REWARDS_API_KEY ||= "unit-test-rewards-api-key-000000000000";
process.env.API_KEY ||= process.env.REWARDS_API_KEY;
process.env.GAME_JWT_SECRET ||= "unit-test-game-jwt-secret-000000000000000000";
process.env.LAUNCHER_JWT_SECRET ||= "unit-test-launcher-jwt-secret-00000000000000";
process.env.DISCORD_SESSION_SECRET ||= "unit-test-discord-session-secret-000000000000";
