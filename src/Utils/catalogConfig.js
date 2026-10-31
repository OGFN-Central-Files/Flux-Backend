import fs from "node:fs";
import path from "node:path";

const catalogConfigPath = path.resolve(process.cwd(), "Config", "catalog_config.json");
const battlePassJsonDir = path.resolve(process.cwd(), "src", "local", "Battlepass", "Jsons");

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function configuredShopEntry(key, item, storefrontName, entryIndex) {
  const itemGrants = Array.isArray(item?.itemGrants)
    ? item.itemGrants
        .map((grant) => {
          if (typeof grant === "string") return { templateId: grant, quantity: 1 };
          if (grant?.templateId) {
            return {
              templateId: String(grant.templateId),
              quantity: Math.max(1, safeNumber(grant.quantity, 1)),
            };
          }
          return null;
        })
        .filter(Boolean)
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
    displayAssetPath: item?.displayAssetPath || "",
    meta: {},
    metaInfo: [],
    appStoreId: [],
    filterWeight: 0,
    matchFilter: "",
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

function configuredBattlePassSeason() {
  const parsed = Number.parseInt(process.env.MAIN_SEASON || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function battlePassExpiration() {
  const configured = String(process.env.BATTLEPASS_END_DATE || process.env.BATTLE_PASS_END_DATE || "").trim();
  const parsed = configured ? new Date(configured) : null;
  if (parsed && Number.isFinite(parsed.getTime()) && parsed.getTime() > Date.now()) {
    return parsed.toISOString();
  }

  return new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
}

function battlePassPrice(finalPrice) {
  const price = Math.max(0, safeNumber(finalPrice, 0));
  return {
    currencyType: "MtxCurrency",
    currencySubType: "",
    regularPrice: price,
    finalPrice: price,
    basePrice: price,
    saleExpiration: battlePassExpiration(),
  };
}

function applyBattlePassOffers(catalog) {
  const season = configuredBattlePassSeason();
  const battlePassPath = path.join(battlePassJsonDir, `Season${season}.json`);

  if (!fs.existsSync(battlePassPath)) return catalog;

  try {
    const battlePass = JSON.parse(fs.readFileSync(battlePassPath, "utf8"));
    const storefrontName = `BRSeason${season}`;
    const offers = [
      { id: battlePass.battlePassOfferId, devName: `[VIRTUAL] 1 x Battle Pass for 950 MtxCurrency`, price: 950, category: "BattlePass" },
      { id: battlePass.battleBundleOfferId, devName: `[VIRTUAL] 1 x Battle Bundle for 2800 MtxCurrency`, price: 2800, category: "BattleBundle" },
      { id: battlePass.tierOfferId, devName: `[VIRTUAL] 1 x Battle Pass Tier for 150 MtxCurrency`, price: 150, category: "BattlePassTier" },
    ];

    for (const offer of offers) {
      if (!offer.id) continue;
      pushCatalogEntry(catalog, storefrontName, {
        offerId: String(offer.id),
        devName: offer.devName,
        offerType: "StaticPrice",
        prices: [battlePassPrice(offer.price)],
        itemGrants: [],
        requirements: [],
        giftInfo: { bIsEnabled: false, forcedGiftBoxTemplateId: "", purchaseRequirements: [], giftRecordIds: [] },
        refundable: false,
        dailyLimit: -1,
        weeklyLimit: -1,
        monthlyLimit: -1,
        sortPriority: 999,
        catalogGroupPriority: 0,
        categories: [`BRSeason${season}`, offer.category],
        displayAssetPath: "",
        meta: {},
        metaInfo: [],
        appStoreId: [],
        filterWeight: 0,
        matchFilter: "",
      });
    }
  } catch {
    // Keep the base catalog usable if battle pass JSON is malformed.
  }

  return catalog;
}

export function applyConfiguredShop(catalog) {
  if (!catalog || typeof catalog !== "object") return catalog;
  applyBattlePassOffers(catalog);
  if (!fs.existsSync(catalogConfigPath)) return catalog;

  try {
    const config = JSON.parse(fs.readFileSync(catalogConfigPath, "utf8"));
    const entries = Array.isArray(config?.entries)
      ? config.entries
      : Object.entries(config || {})
          .filter(([key]) => !key.startsWith("//"))
          .map(([key, value]) => ({ key, ...value }));

    entries.forEach((item, index) => {
      const key = String(item.key || item.id || `item-${index + 1}`).toLowerCase();
      const section = String(item.section || key).toLowerCase();
      const storefrontName = section.includes("featured") || section.includes("weekly")
        ? "BRWeeklyStorefront"
        : "BRDailyStorefront";
      pushCatalogEntry(catalog, storefrontName, configuredShopEntry(key, item, storefrontName, index));
    });
  } catch {
    // Keep the base shop usable if the editable config has a typo.
  }

  return catalog;
}
