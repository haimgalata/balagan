import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CART_STORAGE_KEY, LEGACY_CART_STORAGE_KEY, loadCart, migrateLegacyCart, sanitizeCartItems } from "../../src/lib/cartStorage";
import type { CartItem } from "../../src/types";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtures = (JSON.parse(readFileSync(resolve(ROOT, "tests/baseline/cart-legacy-fixtures.json"), "utf8")) as {
  fixtures: { name: string; storageValue: string }[];
}).fixtures;

const unit = (productId: string, quantity: number): CartItem => ({ productId, option: "unit", quantity });
const pkg = (productId: string, quantity: number): CartItem => ({ productId, option: "package", quantity });

/**
 * Every legacy payload captured from the pre-migration app (tests/baseline) and what it must migrate to.
 * Rules (confirmed): saved units stay UNITS, nothing is deleted just because it can't be resolved,
 * the ancient explicit {type:"pack"} shape keeps its pack choice as PACKAGE lines.
 */
const EXPECTED: Record<string, CartItem[]> = {
  empty: [],
  "one-unit": [unit("1", 1)],
  "nine-units": [unit("1", 9)],
  "ten-units": [unit("1", 10)], // 10 units stay 10 units — never silently a package
  "twenty-three-units": [unit("1", 23)],
  "multi-product": [unit("1", 12), unit("2", 3), unit("3", 1), unit("58", 10)],
  "legacy-pack-shape": [pkg("1", 2), unit("2", 3)],
  "unknown-product-id": [unit("9999", 2), unit("1", 1)], // unresolvable ids are kept, not erased
  "bad-quantities": [unit("5", 2)], // 0, -3 and "5" dropped; 2.7 -> 2
  "duplicate-lines": [unit("1", 12)],
  "not-an-array": [],
  "corrupt-json": [],
};

/** A storage stand-in that records every call, to prove loadCart only ever READS. */
function spyStorage(data: Record<string, string>) {
  const calls: string[] = [];
  return {
    calls,
    storage: {
      getItem: (key: string) => { calls.push(`get:${key}`); return key in data ? data[key] : null; },
    },
  };
}

test.describe("migrateLegacyCart / loadCart — every captured legacy cart", () => {
  for (const fixture of fixtures) {
    test(`${fixture.name}`, () => {
      expect(Object.keys(EXPECTED), "fixture list and expectations must match").toContain(fixture.name);
      const { storage } = spyStorage({ [LEGACY_CART_STORAGE_KEY]: fixture.storageValue });
      expect(loadCart(storage)).toEqual(EXPECTED[fixture.name]);
    });
  }

  test("expectations cover exactly the captured fixtures", () => {
    expect(fixtures.map((f) => f.name).sort()).toEqual(Object.keys(EXPECTED).sort());
  });
});

test.describe("loadCart", () => {
  test("the v2 cart wins over a legacy cart", () => {
    const { storage } = spyStorage({
      [CART_STORAGE_KEY]: JSON.stringify([unit("7", 4), pkg("7", 1)]),
      [LEGACY_CART_STORAGE_KEY]: JSON.stringify([{ productId: "1", quantity: 99 }]),
    });
    expect(loadCart(storage)).toEqual([unit("7", 4), pkg("7", 1)]);
  });

  test("an existing but EMPTY v2 cart is respected (no resurrection of the legacy cart)", () => {
    const { storage } = spyStorage({ [CART_STORAGE_KEY]: "[]", [LEGACY_CART_STORAGE_KEY]: JSON.stringify([{ productId: "1", quantity: 3 }]) });
    expect(loadCart(storage)).toEqual([]);
  });

  test("no v2 => legacy is migrated; neither key => empty", () => {
    expect(loadCart(spyStorage({ [LEGACY_CART_STORAGE_KEY]: JSON.stringify([{ productId: "1", quantity: 3 }]) }).storage)).toEqual([unit("1", 3)]);
    expect(loadCart(spyStorage({}).storage)).toEqual([]);
  });

  test("a corrupt v2 payload gives an empty cart", () => {
    expect(loadCart(spyStorage({ [CART_STORAGE_KEY]: "{oops" }).storage)).toEqual([]);
  });

  test("only ever READS storage — the legacy key is never written or removed", () => {
    const { storage, calls } = spyStorage({ [LEGACY_CART_STORAGE_KEY]: JSON.stringify([{ productId: "1", quantity: 3 }]) });
    loadCart(storage);
    expect(calls).toEqual([`get:${CART_STORAGE_KEY}`, `get:${LEGACY_CART_STORAGE_KEY}`]);
    expect(Object.keys(storage)).toEqual(["getItem"]); // no setItem / removeItem exist to be called
  });
});

test.describe("sanitizeCartItems (v2)", () => {
  test("keeps valid lines, sums duplicates per product+option, floors quantities", () => {
    expect(
      sanitizeCartItems([
        { productId: "1", option: "unit", quantity: 2 },
        { productId: "1", option: "package", quantity: 1 },
        { productId: "1", option: "unit", quantity: 3.9 },
      ])
    ).toEqual([unit("1", 5), pkg("1", 1)]);
  });

  test("drops malformed entries without throwing", () => {
    expect(
      sanitizeCartItems([
        null, "x", 5, [],
        { productId: 1, option: "unit", quantity: 1 }, // id not a string
        { productId: "1", option: "carton", quantity: 1 }, // unknown option
        { productId: "1", option: "unit", quantity: 0 },
        { productId: "1", option: "unit", quantity: -2 },
        { productId: "1", option: "unit", quantity: "3" },
        { productId: "1", option: "unit", quantity: Infinity },
        { productId: "1", option: "unit" },
      ])
    ).toEqual([]);
  });

  test("not an array => empty", () => {
    expect(sanitizeCartItems({ productId: "1" })).toEqual([]);
    expect(sanitizeCartItems(undefined)).toEqual([]);
  });

  test("migrateLegacyCart: unit stays unit, explicit pack -> package, garbage skipped", () => {
    expect(
      migrateLegacyCart([
        { productId: "1", quantity: 4 },
        { productId: "1", type: "unit", quantity: 1 },
        { productId: "2", type: "pack", quantity: 2 },
        { productId: "3", type: "pack", quantity: 0 },
        { quantity: 5 },
      ])
    ).toEqual([unit("1", 5), pkg("2", 2)]);
  });
});
