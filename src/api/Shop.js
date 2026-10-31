import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dirname } from "dirname-filename-esm";
import log from "../Utils/log.js";
import { envBoolean, envInteger, envString } from "../Config/env.js";

const router = express.Router();
const __dirname = dirname(import.meta);

const catalogPath = path.join(__dirname, "../local/Storefront/Catalog.json");
const catalogConfigPath = path.resolve(__dirname, "../../Config/catalog_config.json");
const cosmeticsApiUrl = envString(
  "SHOP_COSMETICS_API_URL",
  "https://fortnite-api.com/v2/cosmetics/br"
);
const cosmeticsCachePath = path.resolve(
  __dirname,
  envString("SHOP_COSMETICS_CACHE_FILE", "../local/Storefront/CosmeticsCache.json")
);
const cosmeticsCacheMs =
  envInteger("SHOP_COSMETICS_CACHE_MINUTES", 30, { min: 1, max: 1440 }) * 60_000;
const cosmeticsTimeoutMs = envInteger("SHOP_COSMETICS_TIMEOUT_MS", 15_000, {
  min: 1_000,
  max: 60_000,
});
const allowStaleCosmetics = envBoolean("SHOP_ALLOW_STALE_COSMETICS", true);
const persistCosmetics = envBoolean("SHOP_PERSIST_COSMETICS_CACHE", true);
const includeRawStorefronts = envBoolean("SHOP_INCLUDE_RAW_STOREFRONTS", false);
const allowCatalogOnly = envBoolean("SHOP_ALLOW_CATALOG_ONLY", true);
const allowManualRefresh = envBoolean("SHOP_ALLOW_MANUAL_REFRESH", false);
const customShopEnabled = envBoolean("CUSTOM_SHOP", true);
const shopMaxSeason = envInteger("SHOP_MAX_SEASON", envInteger("MAIN_SEASON", 35, { min: 1, max: 100 }), {
  min: 1,
  max: 100,
});
const responseMaxAge = envInteger("SHOP_RESPONSE_CACHE_SECONDS", 30, {
  min: 0,
  max: 3600,
});

let cachedCatalog = null;
let cachedCatalogMtime = 0;
let cachedCatalogEtag = "";
let cosmeticsById = new Map();
let cosmeticsLoadedAt = 0;
let cosmeticsSource = "none";
let cosmeticsFetchPromise = null;
let lastCosmeticsError = null;

const itemTypeNames = {
  AthenaBackpack: "backpack",
  AthenaCharacter: "outfit",
  AthenaDance: "emote",
  AthenaEmoji: "emoji",
  AthenaGlider: "glider",
  AthenaItemWrap: "wrap",
  AthenaLoadingScreen: "loading_screen",
  AthenaMusicPack: "music_pack",
  AthenaPickaxe: "pickaxe",
  AthenaSkyDiveContrail: "contrail",
  AthenaSpray: "spray",
  AthenaToy: "toy",
};

const primaryTypePriority = [
  "outfit",
  "backpack",
  "pickaxe",
  "glider",
  "emote",
  "wrap",
  "contrail",
  "music_pack",
  "loading_screen",
  "spray",
  "emoji",
  "toy",
];

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function parseTemplateId(templateId) {
  const value = String(templateId || "").trim();
  const separator = value.indexOf(":");

  if (separator < 0) {
    return { templateType: "Unknown", itemId: value };
  }

  return {
    templateType: value.slice(0, separator),
    itemId: value.slice(separator + 1),
  };
}

function normalizePanel(entry, storefrontName, fallbackIndex = 0) {
  const category = (entry.categories || []).find((value) =>
    /^panel\s*\d+$/i.test(String(value).trim())
  );

  if (category) {
    const match = String(category).match(/(\d+)/);
    const order = match ? Number(match[1]) : fallbackIndex + 1;

    return {
      id: String(category).replace(/\s+/g, "-").toLowerCase(),
      name: String(category).trim(),
      order,
    };
  }

  // Catalogs do not always include Panel N categories. Group those entries by
  // storefront instead of creating a different one-card panel for every offer.
  const defaultName = sectionName(storefrontName);
  return {
    id: `${String(storefrontName || "storefront").toLowerCase()}-default`,
    name: defaultName,
    order: 0,
  };
}

function sectionName(storefrontName) {
  if (storefrontName === "BRDailyStorefront") return "Daily Items";
  if (storefrontName === "BRWeeklyStorefront") return "Featured Items";
  return storefrontName || "Other Items";
}

function itemImage(cosmetic) {
  const images = cosmetic?.images || {};
  return images.featured || images.icon || images.smallIcon || cosmetic?.series?.image || null;
}

function cleanOfferName(devName, primaryName, isBundle) {
  const cleaned = String(devName || "")
    .replace(/\[VIRTUAL\]/gi, "")
    .replace(/^\d+\s*x\s*/i, "")
    .replace(/\s+for\s+\d+\s+\w*Currency.*$/i, "")
    .replace(/^[^:]+:/, "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (isBundle && cleaned && cleaned !== primaryName) return cleaned;
  if (isBundle && primaryName) return `${primaryName} Bundle`;
  return primaryName || cleaned || "Unknown Offer";
}

function rarityPalette(cosmetic) {
  const seriesColors = Array.isArray(cosmetic?.series?.colors)
    ? cosmetic.series.colors.filter(Boolean).slice(0, 5)
    : [];
  const rarity = String(cosmetic?.rarity?.value || "common").toLowerCase();

  const fallback = {
    common: ["b1b1b1ff", "4b4b4bff"],
    uncommon: ["60aa3aff", "174f24ff"],
    rare: ["49acf2ff", "164a8aff"],
    epic: ["c359ffff", "4f168aff"],
    legendary: ["f5a43cff", "8a4216ff"],
    mythic: ["f6d04dff", "9c6d00ff"],
  };

  return seriesColors.length > 0 ? seriesColors : fallback[rarity] || fallback.common;
}

function normalizeGrant(grant, index) {
  const templateId = String(grant?.templateId || "");
  const { templateType, itemId } = parseTemplateId(templateId);
  const cosmetic = cosmeticsById.get(itemId.toLowerCase()) || null;

  return {
    index,
    templateId,
    itemId,
    itemType: itemTypeNames[templateType] || cosmetic?.type?.value || templateType,
    backendType: cosmetic?.type?.backendValue || templateType,
    quantity: Math.max(1, safeNumber(grant?.quantity, 1)),
    found: Boolean(cosmetic),
    displayName: cosmetic?.name || itemId || "Unknown Item",
    description: cosmetic?.description || "",
    rarity: cosmetic?.rarity?.displayValue || null,
    rarityValue: cosmetic?.rarity?.value || null,
    series: cosmetic?.series?.value || null,
    set: cosmetic?.set
      ? {
          name: cosmetic.set.value || null,
          text: cosmetic.set.text || null,
          backendValue: cosmetic.set.backendValue || null,
        }
      : null,
    introduction: cosmetic?.introduction || null,
    images: {
      smallIcon: cosmetic?.images?.smallIcon || null,
      icon: cosmetic?.images?.icon || null,
      featured: cosmetic?.images?.featured || null,
    },
    imageUrl: itemImage(cosmetic),
    colors: rarityPalette(cosmetic),
  };
}

function grantSeason(grant) {
  const value = grant?.introduction?.backendValue;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function itemIsAllowedBySeason(item) {
  const seasons = (item.bundleItems || [])
    .map(grantSeason)
    .filter((season) => season !== null);

  if (seasons.length === 0) return true;
  return Math.max(...seasons) <= shopMaxSeason;
}

function guessTemplateType(itemId) {
  const id = String(itemId || "").toLowerCase();
  if (id.startsWith("cid_")) return "AthenaCharacter";
  if (id.startsWith("bid_") || id.startsWith("backpack_")) return "AthenaBackpack";
  if (id.startsWith("pickaxe_")) return "AthenaPickaxe";
  if (id.startsWith("glider_")) return "AthenaGlider";
  if (id.startsWith("eid_")) return "AthenaDance";
  if (id.startsWith("wrap_")) return "AthenaItemWrap";
  if (id.startsWith("musicpack_") || id.startsWith("music_")) return "AthenaMusicPack";
  if (id.startsWith("lsid_")) return "AthenaLoadingScreen";
  return "AthenaCharacter";
}

function templateIdFromConfiguredValue(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.includes(":")) return raw;
  return `${guessTemplateType(raw)}:${raw}`;
}

function selectPrimaryItem(items) {
  for (const type of primaryTypePriority) {
    const match = items.find((item) => item.itemType === type && item.imageUrl);
    if (match) return match;
  }

  return items.find((item) => item.imageUrl) || items[0] || null;
}

function stableOfferId(entry, storefrontName, entryIndex) {
  if (entry.offerId) return String(entry.offerId);
  const material = JSON.stringify({
    storefrontName,
    entryIndex,
    devName: entry.devName,
    grants: entry.itemGrants,
    prices: entry.prices,
  });
  return crypto.createHash("sha1").update(material).digest("hex");
}

function normalizeEntry(entry, storefrontName, entryIndex) {
  const grants = (entry.itemGrants || []).map(normalizeGrant);
  const primary = selectPrimaryItem(grants);
  const price = entry.prices?.[0] || {};
  const panel = normalizePanel(entry, storefrontName, entryIndex);
  const isBundle = grants.length > 1;
  const regularPrice = safeNumber(price.regularPrice ?? price.finalPrice);
  const finalPrice = safeNumber(price.finalPrice ?? price.regularPrice);
  const discount = Math.max(0, regularPrice - finalPrice);

  return {
    offerId: stableOfferId(entry, storefrontName, entryIndex),
    storefront: storefrontName,
    panelId: panel.id,
    panelName: panel.name,
    panelOrder: panel.order,
    sortPriority: safeNumber(entry.sortPriority),
    catalogGroupPriority: safeNumber(entry.catalogGroupPriority),
    devName: String(entry.devName || ""),
    offerType: entry.offerType || "StaticPrice",

    templateId: primary?.templateId || "",
    itemId: primary?.itemId || "",
    itemType: primary?.itemType || "cosmetic",
    quantity: primary?.quantity || 1,
    displayName: cleanOfferName(entry.devName, primary?.displayName, isBundle),
    description: primary?.description || "",
    rarity: primary?.rarity || null,
    rarityValue: primary?.rarityValue || null,
    series: primary?.series || null,
    set: primary?.set || null,
    imageUrl: primary?.imageUrl || null,
    images: primary?.images || { smallIcon: null, icon: null, featured: null },
    colors: primary?.colors || [],

    isBundle,
    bundleSize: grants.length,
    bundleItems: grants,
    matchedCosmetics: grants.filter((grant) => grant.found).length,
    missingCosmetics: grants.filter((grant) => !grant.found).map((grant) => grant.itemId),

    price: finalPrice,
    regularPrice,
    basePrice: safeNumber(price.basePrice ?? regularPrice),
    discount,
    discountPercent:
      regularPrice > 0 && discount > 0 ? Math.round((discount / regularPrice) * 100) : 0,
    currencyType: price.currencyType || "MtxCurrency",
    currencySubType: price.currencySubType || "",
    saleExpiration: price.saleExpiration || null,

    categories: entry.categories || [],
    displayAssetPath: entry.displayAssetPath || null,
    refundable: Boolean(entry.refundable),
    giftable: Boolean(entry.giftInfo?.bIsEnabled),
    purchaseLimits: {
      daily: safeNumber(entry.dailyLimit, -1),
      weekly: safeNumber(entry.weeklyLimit, -1),
      monthly: safeNumber(entry.monthlyLimit, -1),
    },
    requirements: entry.requirements || [],
  };
}

function configuredShopEntry(key, item, storefrontName, entryIndex) {
  const configuredItems = item?.bundle || item?.items || item?.itemGrants || item?.item;
  const itemGrants = Array.isArray(configuredItems)
    ? configuredItems
        .map((grant) => {
          if (typeof grant === "string") {
            const templateId = templateIdFromConfiguredValue(grant);
            return templateId ? { templateId, quantity: 1 } : null;
          }
          if (grant?.templateId) {
            return {
              templateId: String(grant.templateId),
              quantity: Math.max(1, safeNumber(grant.quantity, 1)),
            };
          }
          if (grant?.id || grant?.item) {
            const templateId = templateIdFromConfiguredValue(grant.id || grant.item);
            return templateId
              ? { templateId, quantity: Math.max(1, safeNumber(grant.quantity, 1)) }
              : null;
          }
          return null;
        })
        .filter(Boolean)
    : configuredItems
      ? [{ templateId: templateIdFromConfiguredValue(configuredItems), quantity: 1 }].filter((grant) => grant.templateId)
    : [];

  if (itemGrants.length === 0) return null;

  const price = Math.max(0, safeNumber(item?.price, 0));
  const panel = String(item?.panel || key || (storefrontName === "BRWeeklyStorefront" ? "Panel 7" : "Panel 1"));

  return {
    offerId: String(item?.offerId || `config:${key}`),
    devName: String(item?.devName || item?.name || `Configured ${key}`),
    offerType: "StaticPrice",
    prices: [{
      currencyType: "MtxCurrency",
      currencySubType: "",
      regularPrice: price,
      finalPrice: price,
      basePrice: price,
      saleExpiration: "9999-12-31T23:59:59.999Z",
    }],
    itemGrants,
    requirements: itemGrants.map((grant) => ({
      requirementType: "DenyOnItemOwnership",
      requiredId: grant.templateId,
      minQuantity: 1,
    })),
    giftInfo: { bIsEnabled: true, forcedGiftBoxTemplateId: "", purchaseRequirements: [], giftRecordIds: [] },
    refundable: true,
    dailyLimit: -1,
    weeklyLimit: -1,
    monthlyLimit: -1,
    sortPriority: safeNumber(item?.sortPriority, 1),
    catalogGroupPriority: safeNumber(item?.catalogGroupPriority, 0),
    categories: [panel],
    displayAssetPath: item?.displayAssetPath || null,
    _configuredEntryIndex: entryIndex,
  };
}

function pushCatalogEntry(catalog, storefrontName, entry) {
  if (!entry) return;
  if (!Array.isArray(catalog.storefronts)) catalog.storefronts = [];

  let storefront = catalog.storefronts.find((candidate) => candidate.name === storefrontName);
  if (!storefront) {
    storefront = { name: storefrontName, catalogEntries: [] };
    catalog.storefronts.push(storefront);
  }

  if (!Array.isArray(storefront.catalogEntries)) storefront.catalogEntries = [];
  storefront.catalogEntries.push(entry);
}

function configuredCatalogBase() {
  return {
    refreshIntervalHrs: 24,
    dailyPurchaseHrs: 24,
    expiration: "9999-12-31T23:59:59.999Z",
    storefronts: [
      { name: "BRDailyStorefront", catalogEntries: [] },
      { name: "BRWeeklyStorefront", catalogEntries: [] },
    ],
  };
}

function configuredEntriesFromSection(sectionName, entries) {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry, index) => ({
    key: `${sectionName}-${index + 1}`,
    section: sectionName,
    panel: sectionName === "featured" ? `Panel ${index + 7}` : `Panel ${index + 1}`,
    ...(
      typeof entry === "string" || Array.isArray(entry)
        ? { [Array.isArray(entry) ? "bundle" : "item"]: entry }
        : entry
    ),
  }));
}

function readConfiguredShopCatalog() {
  const catalog = configuredCatalogBase();
  if (!fs.existsSync(catalogConfigPath)) return catalog;

  try {
    const config = JSON.parse(fs.readFileSync(catalogConfigPath, "utf8"));
    const entries = [
      ...configuredEntriesFromSection("featured", config?.featured),
      ...configuredEntriesFromSection("daily", config?.daily),
      ...(Array.isArray(config?.entries)
      ? config.entries
      : Object.entries(config || {})
          .filter(([key]) => !key.startsWith("//"))
          .filter(([key]) => !["daily", "featured", "autorotatePanels"].includes(key))
          .map(([key, value]) => ({ key, ...value }))),
    ];

    entries.forEach((item, index) => {
      const key = String(item.key || item.id || `item-${index + 1}`).toLowerCase();
      const section = String(item.section || key).toLowerCase();
      const storefrontName = section.includes("featured") || section.includes("weekly")
        ? "BRWeeklyStorefront"
        : "BRDailyStorefront";
      pushCatalogEntry(catalog, storefrontName, configuredShopEntry(key, item, storefrontName, index));
    });
  } catch (error) {
    log.warn(`Unable to load shop config: ${error.message}`);
  }

  return catalog;
}

function shopCatalogForMode() {
  if (customShopEnabled) {
    cachedCatalogMtime = fs.existsSync(catalogConfigPath)
      ? fs.statSync(catalogConfigPath).mtimeMs
      : Date.now();
    cachedCatalogEtag = `W/"custom-${cachedCatalogMtime}"`;
    return readConfiguredShopCatalog();
  }

  return readCatalog();
}

function buildPanels(items) {
  const panels = new Map();

  for (const item of items) {
    if (!panels.has(item.panelId)) {
      panels.set(item.panelId, {
        id: item.panelId,
        name: item.panelName,
        order: item.panelOrder,
        offerCount: 0,
        cosmeticCount: 0,
        items: [],
      });
    }

    const panel = panels.get(item.panelId);
    panel.items.push(item);
    panel.offerCount += 1;
    panel.cosmeticCount += Math.max(1, item.bundleSize);
  }

  return [...panels.values()]
    .map((panel) => ({
      ...panel,
      items: panel.items.sort(
        (a, b) => b.sortPriority - a.sortPriority || a.displayName.localeCompare(b.displayName)
      ),
    }))
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

function buildShopResponse(catalog) {
  const sections = (catalog.storefronts || [])
    .map((storefront) => {
      const items = (storefront.catalogEntries || []).map((entry, index) =>
        normalizeEntry(entry, storefront.name, index)
      ).filter(itemIsAllowedBySeason);
      const panels = buildPanels(items);

      return {
        id: storefront.name,
        name: sectionName(storefront.name),
        offerCount: items.length,
        cosmeticCount: items.reduce((sum, item) => sum + Math.max(1, item.bundleSize), 0),
        panelCount: panels.length,
        panels,
        items,
      };
    })
    .filter((section) => section.offerCount > 0);

  const items = sections.flatMap((section) => section.items);
  const missingCosmetics = [...new Set(items.flatMap((item) => item.missingCosmetics))];

  const response = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    refreshIntervalHrs: safeNumber(catalog.refreshIntervalHrs),
    dailyPurchaseHrs: safeNumber(catalog.dailyPurchaseHrs),
    expiration: catalog.expiration || null,
    updatedAt: new Date(cachedCatalogMtime).toISOString(),
    summary: {
      sectionCount: sections.length,
      panelCount: sections.reduce((sum, section) => sum + section.panelCount, 0),
      offerCount: items.length,
      cosmeticCount: items.reduce((sum, item) => sum + Math.max(1, item.bundleSize), 0),
      bundleCount: items.filter((item) => item.isBundle).length,
      matchedCosmeticCount: items.reduce((sum, item) => sum + item.matchedCosmetics, 0),
      missingCosmeticCount: missingCosmetics.length,
    },
    cosmetics: {
      source: cosmeticsSource,
      apiUrl: cosmeticsApiUrl,
      loadedAt: cosmeticsLoadedAt ? new Date(cosmeticsLoadedAt).toISOString() : null,
      count: cosmeticsById.size,
      stale: cosmeticsLoadedAt > 0 && Date.now() - cosmeticsLoadedAt >= cosmeticsCacheMs,
      lastError: lastCosmeticsError,
    },
    sections,
    items,
  };

  if (includeRawStorefronts) response.storefronts = catalog.storefronts || [];
  return response;
}

function readCatalog() {
  const stat = fs.statSync(catalogPath);

  if (!cachedCatalog || stat.mtimeMs !== cachedCatalogMtime) {
    const text = fs.readFileSync(catalogPath, "utf8");
    cachedCatalog = JSON.parse(text);
    cachedCatalogMtime = stat.mtimeMs;
    cachedCatalogEtag = `W/\"${crypto.createHash("sha1").update(text).digest("hex")}\"`;
  }

  return cachedCatalog;
}

function cosmeticsArrayToMap(data) {
  const map = new Map();
  for (const cosmetic of Array.isArray(data) ? data : []) {
    const id = String(cosmetic?.id || "").trim().toLowerCase();
    if (id) map.set(id, cosmetic);
  }
  return map;
}

function loadDiskCosmeticsCache() {
  if (!persistCosmetics || !fs.existsSync(cosmeticsCachePath)) return false;

  try {
    const document = JSON.parse(fs.readFileSync(cosmeticsCachePath, "utf8"));
    const data = Array.isArray(document) ? document : document.data;
    const map = cosmeticsArrayToMap(data);
    if (map.size === 0) return false;

    cosmeticsById = map;
    cosmeticsLoadedAt = safeNumber(document.savedAt, fs.statSync(cosmeticsCachePath).mtimeMs);
    cosmeticsSource = "disk-cache";
    return true;
  } catch (error) {
    log.warn(`Unable to load shop cosmetics cache: ${error.message}`);
    return false;
  }
}

function saveDiskCosmeticsCache(data) {
  if (!persistCosmetics) return;

  try {
    fs.mkdirSync(path.dirname(cosmeticsCachePath), { recursive: true });
    const temporaryPath = `${cosmeticsCachePath}.tmp`;
    fs.writeFileSync(
      temporaryPath,
      JSON.stringify({ savedAt: Date.now(), data }),
      "utf8"
    );
    fs.renameSync(temporaryPath, cosmeticsCachePath);
  } catch (error) {
    log.warn(`Unable to save shop cosmetics cache: ${error.message}`);
  }
}

async function fetchCosmetics() {
  const response = await fetch(cosmeticsApiUrl, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Flux-Launcher-Shop/2.0",
    },
    signal: AbortSignal.timeout(cosmeticsTimeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Fortnite API returned HTTP ${response.status}`);
  }

  const document = await response.json();
  const data = Array.isArray(document?.data) ? document.data : [];
  const map = cosmeticsArrayToMap(data);

  if (map.size === 0) {
    throw new Error("Fortnite API returned no cosmetics");
  }

  cosmeticsById = map;
  cosmeticsLoadedAt = Date.now();
  cosmeticsSource = "fortnite-api";
  lastCosmeticsError = null;
  saveDiskCosmeticsCache(data);
  return map;
}

async function ensureCosmetics({ force = false } = {}) {
  if (cosmeticsById.size === 0) loadDiskCosmeticsCache();

  const fresh =
    cosmeticsById.size > 0 && Date.now() - cosmeticsLoadedAt < cosmeticsCacheMs;
  if (!force && fresh) return cosmeticsById;

  if (!cosmeticsFetchPromise) {
    cosmeticsFetchPromise = fetchCosmetics().finally(() => {
      cosmeticsFetchPromise = null;
    });
  }

  try {
    return await cosmeticsFetchPromise;
  } catch (error) {
    lastCosmeticsError = error.message;

    if (allowStaleCosmetics && cosmeticsById.size > 0) {
      log.warn(`Using stale shop cosmetics metadata: ${error.message}`);
      cosmeticsSource = cosmeticsSource === "none" ? "stale-cache" : cosmeticsSource;
      return cosmeticsById;
    }

    if (allowCatalogOnly) {
      log.warn(`Serving catalog-only shop metadata: ${error.message}`);
      cosmeticsSource = "catalog-only";
      return cosmeticsById;
    }

    throw error;
  }
}

function applyFilters(response, query) {
  const sectionFilter = String(query.section || "").trim().toLowerCase();
  const panelFilter = String(query.panel || "").trim().toLowerCase();
  const search = String(query.search || "").trim().toLowerCase();

  if (!sectionFilter && !panelFilter && !search) return response;

  const sections = response.sections
    .filter(
      (section) =>
        !sectionFilter ||
        section.id.toLowerCase() === sectionFilter ||
        section.name.toLowerCase().includes(sectionFilter)
    )
    .map((section) => {
      const items = section.items.filter((item) => {
        const panelMatches =
          !panelFilter ||
          item.panelId.toLowerCase() === panelFilter ||
          item.panelName.toLowerCase().includes(panelFilter);
        const searchMatches =
          !search ||
          item.displayName.toLowerCase().includes(search) ||
          item.itemId.toLowerCase().includes(search) ||
          item.bundleItems.some((grant) =>
            `${grant.displayName} ${grant.itemId}`.toLowerCase().includes(search)
          );
        return panelMatches && searchMatches;
      });

      const panels = buildPanels(items);
      return {
        ...section,
        offerCount: items.length,
        cosmeticCount: items.reduce((sum, item) => sum + Math.max(1, item.bundleSize), 0),
        panelCount: panels.length,
        panels,
        items,
      };
    })
    .filter((section) => section.items.length > 0);

  const items = sections.flatMap((section) => section.items);
  return {
    ...response,
    filtered: true,
    filters: {
      section: sectionFilter || null,
      panel: panelFilter || null,
      search: search || null,
    },
    sections,
    items,
  };
}

router.get("/shop", async (req, res) => {
  try {
    const catalog = shopCatalogForMode();
    const forceRefresh = allowManualRefresh && req.query.refresh === "1";
    await ensureCosmetics({ force: forceRefresh });

    const response = applyFilters(buildShopResponse(structuredClone(catalog)), req.query);
    const responseEtag = `W/"${crypto
      .createHash("sha1")
      .update(`${cachedCatalogEtag}:${cosmeticsLoadedAt}:${req.originalUrl}`)
      .digest("hex")}"`;

    if (req.headers["if-none-match"] === responseEtag && !forceRefresh) {
      return res.status(304).end();
    }
    res.set({
      "Cache-Control": `public, max-age=${responseMaxAge}, stale-while-revalidate=300`,
      ETag: responseEtag,
      "Last-Modified": new Date(cachedCatalogMtime).toUTCString(),
      "X-Shop-Schema": "2",
    });
    return res.status(200).json(response);
  } catch (error) {
    log.error(`Launcher shop API failed: ${error.message}`);
    return res.status(500).json({
      error: "shop_unavailable",
      message: "Unable to load the item shop.",
      details: envBoolean("SHOW_ERROR_DETAILS", false) ? error.message : undefined,
    });
  }
});

router.get("/shop/status", async (_req, res) => {
  try {
    const catalog = shopCatalogForMode();
    await ensureCosmetics();
    const response = buildShopResponse(structuredClone(catalog));

    return res.status(200).json({
      healthy: true,
      mode: customShopEnabled ? "custom" : "autorotate",
      catalogPath,
      catalogConfigPath,
      catalogUpdatedAt: response.updatedAt,
      expiration: response.expiration,
      summary: response.summary,
      cosmetics: response.cosmetics,
    });
  } catch (error) {
    return res.status(503).json({
      healthy: false,
      error: error.message,
      cosmetics: {
        source: cosmeticsSource,
        count: cosmeticsById.size,
        lastError: lastCosmeticsError,
      },
    });
  }
});

router.get("/shop/raw", (_req, res) => {
  try {
    res.set("Cache-Control", `public, max-age=${responseMaxAge}`);
    return res.status(200).json(shopCatalogForMode());
  } catch (error) {
    log.error(`Launcher raw shop API failed: ${error.message}`);
    return res.status(500).json({
      error: "shop_unavailable",
      message: "Unable to load the item shop.",
    });
  }
});

export {
  applyFilters,
  buildPanels,
  buildShopResponse,
  normalizeEntry,
  parseTemplateId,
};

export default router;
