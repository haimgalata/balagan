import { test, expect } from "../../catalog/fixtures";
import { ADMIN_USER, STAFF_USER, seedSession, sessionFor, stubSupabase } from "../auth/adminStubs";
import { createFakeCosts, type FakeCosts } from "./fakeDatabase";
import type { Page } from "@playwright/test";

/**
 * The owner's "עלויות ורווח" (/admin/costs) and "סריקה" (/admin/scan) screens against an in-memory fake of migration 0016
 * (fakeDatabase.ts). The camera can't run in a test, so scanning is driven by typing the barcode number — the same path
 * the camera feeds. The database rules themselves are covered by scripts/verify-order-management.mjs.
 */
test.beforeEach(({ mode }) => {
  test.skip(mode !== "supabase", "costs tests use the stubbed-database variant");
});

async function openAt(page: Page, path: string, db: FakeCosts = createFakeCosts()) {
  await stubSupabase(page, { extra: db.handle });
  await seedSession(page, sessionFor(ADMIN_USER));
  await page.goto(path);
  return db;
}

const row = (page: Page, id: string) => page.getByTestId(`cost-row-${id}`);
const drawer = (page: Page) => page.locator('[role="dialog"][aria-label="עלות ורווח"]');

test("per supplier: cost incl. VAT, net profit in ₪ and %, coloured by the 5% line", async ({ page }) => {
  await openAt(page, "/admin/costs");
  await expect(page.getByRole("heading", { name: "עלויות ורווח", level: 1 })).toBeVisible();
  await expect(page.getByRole("tab", { name: /פיליפ מוריס/ })).toHaveAttribute("aria-selected", "true");

  // the agreed example: 42 ₪, cost 33.46 → 39.48 incl. VAT, net profit 2.13 ₪ · 6%
  await expect(row(page, "2")).toContainText("₪42.00");
  await expect(row(page, "2")).toContainText("₪39.48");
  await expect(row(page, "2")).toContainText("₪2.13 · 6%");
  await expect(row(page, "2").locator("[data-tone]")).toHaveAttribute("data-tone", "good");
  await expect(row(page, "2")).toContainText("↑₪0.56"); // up from 32.90 on the previous invoice
  await expect(row(page, "46")).toContainText("מחיר לא מהקופה");
  await expect(row(page, "46").locator("[data-tone]")).toHaveAttribute("data-tone", "loss");
  await expect(page.getByTestId("costs-count-cost")).toHaveText("3 מתוך 3 עם עלות");
  await expect(page.getByTestId("costs-count-barcode")).toHaveText("1 מתוך 3 עם ברקוד");

  await page.getByRole("tab", { name: /גלוברנדס/ }).click();
  await expect(row(page, "8").locator("[data-tone]")).toHaveAttribute("data-tone", "low");
  await expect(row(page, "2")).toHaveCount(0);
  await page.getByLabel("רק רווח נמוך").check();
  await expect(page.getByTestId("costs-table").locator("tbody tr")).toHaveCount(2);

  await page.getByRole("tab", { name: /דובק/ }).click();
  await page.getByLabel("רק רווח נמוך").uncheck();
  await expect(row(page, "65"), "tobacco with a cost is listed too").toBeVisible();
  await page.getByRole("tab", { name: /ללא ספק/ }).click();
  await expect(row(page, "300")).toContainText("אין עלות");
});

test("the detail panel spells out the calculation, edits the cost (before VAT) and the supplier, and shows history", async ({ page }) => {
  const db = await openAt(page, "/admin/costs");
  await row(page, "2").getByRole("button", { name: "מרלבורו גולד" }).click();
  const d = drawer(page);
  await expect(d.getByTestId("cost-breakdown")).toContainText("₪35.59");
  await expect(d.getByTestId("cost-breakdown")).toContainText("₪2.13 · 6%");
  await expect(d.getByTestId("cost-history").locator("li")).toHaveCount(2);
  await expect(d.getByTestId("cost-history")).toContainText("חשבונית 0111270741 · 15/10/2026");

  await d.getByLabel(/עלות חדשה לחפיסה/).fill("34");
  await expect(d).toContainText("כולל מע\"מ: ₪40.12");
  await d.getByRole("button", { name: "שמירה" }).click();
  await expect(d.getByRole("status")).toHaveText("נשמר.");
  expect(db.setCalls.at(-1)).toEqual({ p_product_id: "2", p_supplier_id: "philip-morris", p_cost_ex_vat: 34 });
  await expect(d.getByTestId("cost-history").locator("li")).toHaveCount(3);
  await expect(row(page, "2")).toContainText("₪1.59"); // 35.59 − 34

  await d.getByLabel("ספק").selectOption("dubek");
  await d.getByRole("button", { name: "שמירה" }).click();
  expect(db.setCalls.at(-1)).toEqual({ p_product_id: "2", p_supplier_id: "dubek", p_cost_ex_vat: null });
  await expect(row(page, "2")).toHaveCount(0); // moved to the Dubek tab
});

test("the review note can be cleared once checked", async ({ page }) => {
  const db = await openAt(page, "/admin/costs");
  await row(page, "46").getByRole("button", { name: "נקסט ריסס" }).click();
  await drawer(page).getByRole("button", { name: "בדקתי, להסיר" }).click();
  await expect(row(page, "46")).not.toContainText("מחיר לא מהקופה");
  expect(db.products.find((x) => x.id === "46")?.review_note).toBeNull();
});

test("staff never sees the costs or scan screens", async ({ page }) => {
  await stubSupabase(page, { users: [ADMIN_USER, STAFF_USER], extra: createFakeCosts().handle });
  await seedSession(page, sessionFor(STAFF_USER));
  await page.goto("/admin/costs");
  await expect(page).toHaveURL(/\/admin\/orders$/);
  const nav = page.getByRole("navigation", { name: "ניווט ניהול" });
  await expect(nav.getByRole("link", { name: "עלויות ורווח" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "סריקה" })).toHaveCount(0);
});

// ---------------------------------------------------------------------------------------------------- scanning
const scan = async (page: Page, code: string) => {
  await page.getByLabel("מספר ברקוד").fill(code);
  await page.getByRole("button", { name: "חיפוש", exact: true }).click();
};
const step = (page: Page) => page.getByTestId("scan-step");

test("a known barcode shows the product with its cost and net profit", async ({ page }) => {
  await openAt(page, "/admin/scan");
  await scan(page, "7290 0000 00001");
  await expect(step(page)).toHaveAttribute("data-step", "known");
  await expect(step(page)).toContainText("מרלבורו גולד");
  await expect(step(page)).toContainText("₪2.13 · 6%");
});

test("a carton barcode on the blocklist is refused with a warning", async ({ page }) => {
  await openAt(page, "/admin/scan");
  await scan(page, "7290000000999");
  await expect(step(page)).toHaveAttribute("data-step", "blocked");
  await expect(step(page)).toContainText("זה ברקוד של פקט");
});

test("unknown barcode → 'not a single pack' puts it on the blocklist and saves nothing else", async ({ page }) => {
  const db = await openAt(page, "/admin/scan");
  await scan(page, "7290000000555");
  await expect(step(page)).toContainText("זו חפיסה בודדת?");
  await page.getByRole("button", { name: "לא, זה פקט" }).click();
  await expect(step(page)).toContainText("סומן כברקוד של פקט");
  expect(db.blocklist.map((b) => b.barcode)).toContain("7290000000555");
  expect(db.products.some((x) => x.barcode === "7290000000555")).toBe(false);
});

test("unknown barcode → single pack → pick the product → saved on it", async ({ page }) => {
  const db = await openAt(page, "/admin/scan");
  await expect(page.getByTestId("missing-barcodes")).toContainText("סיגריות בלי ברקוד: 6");
  await scan(page, "7290000000123");
  await page.getByRole("button", { name: "כן, חפיסה בודדת" }).click();
  await page.getByLabel("חיפוש מוצר").fill("ווינסטון");
  await expect(page.getByTestId("scan-results").locator("li")).toHaveCount(2);
  await page.getByRole("button", { name: /ווינסטון כחול/ }).click();
  await page.getByRole("button", { name: "כן, לשמור" }).click();
  await expect(step(page)).toContainText('הברקוד נשמר על "ווינסטון כחול"');
  expect(db.products.find((x) => x.id === "4")?.barcode).toBe("7290000000123");
  await expect(page.getByTestId("missing-barcodes")).toContainText("סיגריות בלי ברקוד: 5");
});

test("a barcode on the wrong product moves only after a confirmation", async ({ page }) => {
  const db = await openAt(page, "/admin/scan");
  await scan(page, "7290000000001");
  await page.getByRole("button", { name: "זה לא המוצר הנכון" }).click();
  await page.getByLabel("חיפוש מוצר").fill("אדום");
  await page.getByRole("button", { name: /מרלבורו אדום/ }).click();
  await expect(step(page)).toContainText('מ-"מרלבורו גולד" אל "מרלבורו אדום"');
  expect(db.products.find((x) => x.id === "2")?.barcode, "nothing moved before the confirmation").toBe("7290000000001");
  await page.getByRole("button", { name: "כן, להעביר" }).click();
  await expect(step(page)).toContainText("הברקוד הועבר");
  expect(db.products.find((x) => x.id === "2")?.barcode).toBeNull();
  expect(db.products.find((x) => x.id === "1")?.barcode).toBe("7290000000001");
});

test("a product that isn't on the site yet: created hidden and flagged when there's no price", async ({ page }) => {
  const db = await openAt(page, "/admin/scan");
  await scan(page, "7290000000777");
  await page.getByRole("button", { name: "כן, חפיסה בודדת" }).click();
  await page.getByRole("button", { name: "המוצר לא קיים באתר" }).click();
  await page.getByLabel("שם (כמו בקופה)").fill("מרלבורו טיון");
  await page.getByLabel("מותג").selectOption({ label: "מרלבורו" });
  await page.getByRole("button", { name: "יצירת מוצר" }).click();
  await expect(step(page)).toContainText("המוצר נוצר מוסתר");
  expect(db.inserts.at(-1)).toMatchObject({ category_id: "cat-cigarettes", subcategory_id: "sub-marlboro", name_he: "מרלבורו טיון", unit_price: 0, is_visible: false, review_note: "נוצר בסריקה, חסר מחיר", barcode: "7290000000777" });
});
