import crypto from "node:crypto";
import Users from "../../User/Mongodb/Schema/user.js";
import { envInteger, envString } from "../../Config/env.js";

const PASSWORD_GROUPS = [
  "ABCDEFGHJKLMNPQRSTUVWXYZ",
  "abcdefghijkmnopqrstuvwxyz",
  "23456789",
  "!@#$%",
];
const PASSWORD_ALPHABET = PASSWORD_GROUPS.join("");

function randomCharacter(alphabet) {
  return alphabet[crypto.randomInt(0, alphabet.length)];
}

function secureShuffle(characters) {
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(0, index + 1);
    [characters[index], characters[swapIndex]] = [characters[swapIndex], characters[index]];
  }
  return characters;
}

function generatePassword(length) {
  const characters = PASSWORD_GROUPS.map(randomCharacter);
  while (characters.length < length) characters.push(randomCharacter(PASSWORD_ALPHABET));
  return secureShuffle(characters).join("");
}

function sanitizeUsername(value, fallback = "") {
  const cleaned = String(value || "")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .replace(/^[-_]+|[-_]+$/g, "");
  return cleaned || fallback;
}

function accountEmailDomain() {
  const domain = envString("ACCOUNT_EMAIL_DOMAIN", "flux.dev")
    .toLowerCase()
    .replace(/^@/, "")
    .trim();

  const valid =
    domain.length <= 253 &&
    domain.includes(".") &&
    !domain.includes("..") &&
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/.test(domain);

  if (!valid) {
    throw new Error("ACCOUNT_EMAIL_DOMAIN must be a valid domain such as accounts.example.com");
  }
  return domain;
}

export async function generateAccountCredentials(discordUser) {
  const maxUsernameLength = envInteger("ACCOUNT_USERNAME_MAX_LENGTH", 24, { min: 3, max: 32 });
  const prefix = sanitizeUsername(envString("ACCOUNT_USERNAME_PREFIX"));
  const source = sanitizeUsername(discordUser.globalName || discordUser.username, "player");
  const prefixText = prefix ? `${prefix}_` : "";
  const base = `${prefixText}${source}`.slice(0, maxUsernameLength);
  const domain = accountEmailDomain();
  const minimumPasswordLength = envInteger("ACCOUNT_PASSWORD_MIN_LENGTH", 8, { min: 8, max: 64 });
  const passwordLength = envInteger("ACCOUNT_PASSWORD_LENGTH", Math.max(16, minimumPasswordLength), {
    min: Math.max(12, minimumPasswordLength),
    max: 64,
  });
  const maxAttempts = envInteger("ACCOUNT_GENERATION_ATTEMPTS", 30, { min: 5, max: 100 });
  const discordId = String(discordUser.id || "").trim();

  if (!/^\d{6,32}$/.test(discordId)) {
    throw new Error("A valid Discord user ID is required to generate credentials");
  }

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const suffix = attempt === 0 ? "" : String(crypto.randomInt(10, 10000));
    const availableBaseLength = Math.max(1, maxUsernameLength - suffix.length);
    const username = `${base.slice(0, availableBaseLength)}${suffix}`.slice(0, maxUsernameLength);
    const emailLocal = username.toLowerCase().replace(/[^a-z0-9._-]/g, "");
    const email = `${emailLocal}.${discordId.slice(-6)}@${domain}`;

    const duplicate = await Users.exists({
      $or: [
        { username_lower: username.toLowerCase() },
        { email: email.toLowerCase() },
      ],
    });

    if (!duplicate) {
      return {
        username,
        email,
        password: generatePassword(passwordLength),
      };
    }
  }

  throw new Error("Unable to generate unique account credentials");
}
