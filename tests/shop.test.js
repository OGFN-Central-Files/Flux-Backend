import test from "node:test";
import assert from "node:assert/strict";

import {
  applyFilters,
  buildPanels,
  buildShopResponse,
  normalizeEntry,
  parseTemplateId,
} from "../src/api/Shop.js";

test("shop template IDs preserve IDs containing underscores", () => {
  assert.deepEqual(parseTemplateId("AthenaCharacter:CID_703_Athena_Commando_M_Cyclone"), {
    templateType: "AthenaCharacter",
    itemId: "CID_703_Athena_Commando_M_Cyclone",
  });
});

test("shop normalization preserves every grant in a catalog offer", () => {
  const offer = normalizeEntry(
    {
      offerId: "offer-1",
      devName: "Example bundle",
      categories: ["Panel 7"],
      prices: [{ regularPrice: 2000, finalPrice: 1500, basePrice: 2000 }],
      itemGrants: [
        { templateId: "AthenaCharacter:CID_Test", quantity: 1 },
        { templateId: "AthenaBackpack:BID_Test", quantity: 1 },
        { templateId: "AthenaPickaxe:Pickaxe_ID_Test", quantity: 1 },
      ],
      giftInfo: { bIsEnabled: true },
      refundable: true,
    },
    "BRWeeklyStorefront",
    0
  );

  assert.equal(offer.isBundle, true);
  assert.equal(offer.bundleSize, 3);
  assert.equal(offer.bundleItems.length, 3);
  assert.equal(offer.panelId, "panel-7");
  assert.equal(offer.price, 1500);
  assert.equal(offer.discount, 500);
  assert.equal(offer.discountPercent, 25);
});

test("shop panels group offers by catalog panel instead of merging offers", () => {
  const panels = buildPanels([
    { panelId: "panel-7", panelName: "Panel 7", panelOrder: 7, sortPriority: 2, displayName: "A", bundleSize: 1 },
    { panelId: "panel-7", panelName: "Panel 7", panelOrder: 7, sortPriority: 1, displayName: "B", bundleSize: 2 },
    { panelId: "panel-8", panelName: "Panel 8", panelOrder: 8, sortPriority: 1, displayName: "C", bundleSize: 1 },
  ]);

  assert.equal(panels.length, 2);
  assert.equal(panels[0].offerCount, 2);
  assert.equal(panels[0].cosmeticCount, 3);
  assert.deepEqual(panels[0].items.map((item) => item.displayName), ["A", "B"]);
});

test("shop response remains compatible while exposing panel metadata", () => {
  const response = buildShopResponse({
    refreshIntervalHrs: 24,
    dailyPurchaseHrs: 24,
    expiration: "2099-01-01T00:00:00.000Z",
    storefronts: [
      {
        name: "BRDailyStorefront",
        catalogEntries: [
          {
            offerId: "daily-1",
            devName: "AthenaDance:EID_Test",
            categories: ["Panel 1"],
            prices: [{ finalPrice: 500, regularPrice: 500 }],
            itemGrants: [{ templateId: "AthenaDance:EID_Test", quantity: 1 }],
          },
        ],
      },
    ],
  });

  assert.equal(response.schemaVersion, 2);
  assert.equal(response.sections[0].name, "Daily Items");
  assert.equal(response.sections[0].panels.length, 1);
  assert.equal(response.items.length, 1);
  assert.equal(response.summary.offerCount, 1);
});

test("shop filters search inside bundle grant names and IDs", () => {
  const response = {
    sections: [
      {
        id: "BRWeeklyStorefront",
        name: "Featured Items",
        items: [
          {
            panelId: "panel-7",
            panelName: "Panel 7",
            panelOrder: 7,
            displayName: "Example Bundle",
            itemId: "CID_Main",
            bundleSize: 2,
            sortPriority: 1,
            bundleItems: [
              { displayName: "Hidden Pickaxe", itemId: "Pickaxe_Hidden" },
            ],
          },
        ],
      },
    ],
  };

  const filtered = applyFilters(response, { search: "hidden pickaxe" });
  assert.equal(filtered.items.length, 1);
  assert.equal(filtered.sections[0].panels.length, 1);
});

test("shop entries without explicit panel categories remain grouped by storefront", () => {
  const first = normalizeEntry(
    {
      offerId: "daily-1",
      devName: "Daily one",
      prices: [{ regularPrice: 800, finalPrice: 800 }],
      itemGrants: [{ templateId: "AthenaDance:EID_TestOne", quantity: 1 }],
    },
    "BRDailyStorefront",
    0
  );
  const second = normalizeEntry(
    {
      offerId: "daily-2",
      devName: "Daily two",
      prices: [{ regularPrice: 500, finalPrice: 500 }],
      itemGrants: [{ templateId: "AthenaItemWrap:Wrap_TestTwo", quantity: 1 }],
    },
    "BRDailyStorefront",
    1
  );

  const panels = buildPanels([first, second]);
  assert.equal(panels.length, 1);
  assert.equal(panels[0].name, "Daily Items");
  assert.equal(panels[0].items.length, 2);
});
