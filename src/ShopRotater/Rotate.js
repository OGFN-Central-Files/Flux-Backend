import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import "dotenv/config";
import cron from 'node-cron';
import Log from "../Utils/log.js";
import { envBoolean, envInteger, envString } from "../Config/env.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = envInteger("SHOP_ROTATER_PORT", 75, { min: 1, max: 65535 });

const CATALOG_PATH = path.join(__dirname, '../local/Storefront/Catalog.json');
const CONFIG_PATH = path.resolve(__dirname, '../../Config/catalog_config.json');
const API_URL = envString("SHOP_COSMETICS_API_URL", "https://fortnite-api.com/v2/cosmetics/br");

const MAIN_SEASON = envInteger("MAIN_SEASON", 10, { min: 1, max: 100 });
const SHOP_MAX_SEASON = envInteger("SHOP_MAX_SEASON", MAIN_SEASON, { min: 1, max: 100 });

const CUSTOM_SHOP = envBoolean("CUSTOM_SHOP", true);
const ROTATE_SHOP = envBoolean("ROTATE_SHOP", !CUSTOM_SHOP);
const autorotatePanels = readAutorotatePanels();
const DAILY_PANEL_COUNT = envInteger("SHOP_AUTOROTATE_DAILY_PANELS", autorotatePanels.daily, { min: 1, max: 20 });
const FEATURED_PANEL_COUNT = envInteger("SHOP_AUTOROTATE_FEATURED_PANELS", autorotatePanels.featured, { min: 1, max: 20 });
const SEND_WEBHOOK = envBoolean("SEND_WEBHOOK", false);
const WEBHOOK_URL = envString("SHOP_WEBHOOK_URL", envString("LOG_WEBHOOK"));
const PING_ROLE_ID = envString("SHOP_PING_ROLE_ID");
const PREMEDITATED_SHOP = envBoolean("PREMEDITATED_SHOP", false);
const FORCE_ROTATE_KEY = envString("SHOP_ROTATE_API_KEY");
const SHOP_TIMEZONE = envString("SHOP_ROTATION_TIMEZONE", "America/Chicago");

let cosmetics = [];

function readAutorotatePanels() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return {
      daily: Number(config?.autorotatePanels?.daily) || 6,
      featured: Number(config?.autorotatePanels?.featured) || 4,
    };
  } catch {
    return { daily: 6, featured: 4 };
  }
}

let preShopData = null;
if (PREMEDITATED_SHOP) {
  try {
    const preShopPath = path.join(__dirname, 'PreShop', 'PreShop.json');
    preShopData = JSON.parse(fs.readFileSync(preShopPath, 'utf-8'));
  } catch (err) {
    Log.error(`Failed to load PreShop.json: ${err.message}`);
  }
}

async function fetchCosmetics() {
  if (PREMEDITATED_SHOP && preShopData) {
    cosmetics = preShopData;
    return true;
  }

  try {
    const response = await fetch(API_URL, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { data } = await response.json();
    cosmetics = Array.isArray(data) ? data : data || [];
    return true;
  } catch (err) {
    Log.error(`Failed to fetch cosmetics: ${err.message}`);
    return false;
  }
}

function isAllowedItem(item) {
  const intro = item.introduction?.backendValue;
  if (!intro || intro > SHOP_MAX_SEASON) return false;
  return item.rarity.value !== 'common';
}

function getPrice(rarity, type) {
  const r = rarity.toLowerCase();

  const prices = {
    emote: { uncommon: 200, rare: 500, epic: 800, legendary: 1200 },
    uncommon: { glider: 500, wrap: 200, backpack: 200, pickaxe: 500, outfit: 800 },
    rare: { glider: 800, wrap: 500, backpack: 500, pickaxe: 800, music: 200, outfit: 1200 },
    epic: { glider: 1200, wrap: 800, backpack: 800, pickaxe: 1000, outfit: 1500 },
    legendary: { backpack: 1000, glider: 2000, outfit: 2000 }
  };

  if (prices[type]?.[r]) return prices[type][r];
  if (prices[r]?.[type]) return prices[r][type];

  if (r === 'uncommon') return Math.floor(Math.random() * 301) + 500;
  if (r === 'rare') return Math.floor(Math.random() * 201) + 800;
  if (r === 'epic') return Math.floor(Math.random() * 301) + 1200;
  if (r === 'legendary') return Math.floor(Math.random() * 401) + 1600;

  return 800;
}

function getTemplateId(item) {
  return `${item.type?.backendValue || 'Athena'}:${item.id}`;
}

function generateDisplayAssetPath(item) {
  return item.id ? `/Game/Catalog/DisplayAssets/DA_Featured_${item.id}.DA_Featured_${item.id}` : '';
}

function generateCatalogEntry(item, addDisplayAsset = false) {
  const price = getPrice(item.rarity.value, item.type?.value);
  const templateId = getTemplateId(item);

  const entry = {
    offerId: uuidv4(),
    devName: templateId,
    offerType: "StaticPrice",
    prices: [{
      currencyType: "MtxCurrency",
      regularPrice: price,
      finalPrice: price,
      basePrice: price,
      saleExpiration: "9999-12-31T23:59:59.999Z"
    }],
    itemGrants: [{ templateId, quantity: 1 }],
    requirements: [{
      requirementType: "DenyOnItemOwnership",
      requiredId: templateId,
      minQuantity: 1
    }],
    giftInfo: { bIsEnabled: true, forcedGiftBoxTemplateId: "", purchaseRequirements: [], giftRecordIds: [] },
    refundable: true,
    dailyLimit: -1,
    weeklyLimit: -1,
    monthlyLimit: -1,
    sortPriority: 1,
    catalogGroupPriority: 0
  };

  if (addDisplayAsset) {
    entry.displayAssetPath = generateDisplayAssetPath(item);
  }

  return entry;
}

async function sendShopWebhook(dailyItems, featuredPanels) {
  if (!SEND_WEBHOOK || !WEBHOOK_URL) return;

  const now = new Date();
  const nextRotation = new Date(now);
  nextRotation.setHours(19, 0, 0, 0);
  if (nextRotation <= now) nextRotation.setDate(nextRotation.getDate() + 1);

  const embed = {
    title: `Item Shop — ${now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}`,
    description: `Next rotation: <t:${Math.floor(nextRotation / 1000)}:F>`,
    color: 0x00ff00,
    fields: [
      {
        name: "Daily Section",
        value: dailyItems.length
          ? dailyItems.map(i => `**${i.name}** — ${getPrice(i.rarity.value, i.type?.value)} V-Bucks`).join('\n')
          : "No items today",
        inline: false
      },
      {
        name: "Featured Sets",
        value: featuredPanels.length
          ? featuredPanels.map((panel, i) => `**Panel ${i + 7}**\n${panel.map(item => item.name).join('\n')}`).join('\n\n')
          : "No featured sets",
        inline: false
      }
    ],
    timestamp: new Date().toISOString(),
    footer: { text: "Rotated Item Shop" }
  };

  try {
    if (PING_ROLE_ID) {
      await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `<@&${PING_ROLE_ID}>` })
      });
    }

    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] })
    });
  } catch (err) {
    Log.warn(`Shop webhook failed: ${err.message}`);
  }
}

async function generateRotatedShop() {
  if (CUSTOM_SHOP) {
    Log.warn("CUSTOM_SHOP is enabled; skipping autorotation.");
    return;
  }

  if (!ROTATE_SHOP) {
    return;
  }

  if (!(await fetchCosmetics())) return;

  const allowedItems = cosmetics.filter(isAllowedItem);
  if (allowedItems.length < 30) {
    return;
  }

  const sets = new Map();
  allowedItems.forEach(item => {
    const setKey = item.set?.backendValue || 'no_set';
    if (!sets.has(setKey)) sets.set(setKey, []);
    sets.get(setKey).push(item);
  });

  const validSets = Array.from(sets)
    .filter(([key]) => key !== 'no_set')
    .map(([, items]) => items)
    .filter(items => items.length >= 2);

  validSets.sort(() => Math.random() - 0.5);
  validSets.forEach(set => set.sort(() => Math.random() - 0.5));

  const soloItems = [...(sets.get('no_set') || []), ...validSets.flatMap(s => s.slice(3))];
  const shuffledDaily = soloItems.sort(() => Math.random() - 0.5).slice(0, DAILY_PANEL_COUNT);

  const dailyEntries = shuffledDaily.map((item, i) => {
    const entry = generateCatalogEntry(item);
    entry.categories = [`Panel ${i + 1}`];
    return entry;
  });

  const featuredEntries = [];
  const featuredPanels = [];

  for (let i = 0; i < FEATURED_PANEL_COUNT && i < validSets.length; i++) {
    const set = validSets[i];
    const panelItems = [];

    set.forEach((item, pos) => {
      const entry = generateCatalogEntry(item, true);
      entry.categories = [`Panel ${i + 7}`];
      entry.sortPriority = [4, 3, 2, 1][pos] || 1;
      featuredEntries.push(entry);
      panelItems.push(item);
    });

    featuredPanels.push(panelItems);
  }

  const catalog = {
    refreshIntervalHrs: 24,
    dailyPurchaseHrs: 24,
    expiration: "9999-12-31T00:00:00.000Z",
    storefronts: [
      { name: "BRDailyStorefront", catalogEntries: dailyEntries },
      { name: "BRWeeklyStorefront", catalogEntries: featuredEntries }
    ]
  };

  try {
    fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2));
  } catch (err) {
    return;
  }

  await sendShopWebhook(shuffledDaily, featuredPanels);
}

app.post('/force-rotate', async (req, res) => {
  if (!FORCE_ROTATE_KEY) return res.status(404).json({ error: "not_found" });
  if (req.get("x-api-key") !== FORCE_ROTATE_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  await generateRotatedShop();
  return res.json({ success: true, message: "Shop manually rotated!" });
});

if (!CUSTOM_SHOP && ROTATE_SHOP) {
  cron.schedule('0 19 * * *', generateRotatedShop, {
    scheduled: true,
    timezone: SHOP_TIMEZONE
  });
}

app.listen(PORT, () => {
  Log.backend(`Shop rotator running on port ${PORT}`);
});
